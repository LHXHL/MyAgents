//! Narrow fixed-origin account adapter for the App's Agent Network owner.
//! The original account owner retains the opaque token and exact login binding.
use super::*;
use crate::agent_network::NetworkError;

pub(crate) enum AccountOperation {
    IdentityState(String),
    Identity,
    Certificate,
    Rotate,
    Challenge,
    Current,
    Jwks,
}
impl AccountOperation {
    fn request(&self) -> Result<(reqwest::Method, String, bool), NetworkError> {
        let (method, path, authenticated) = match self {
            Self::IdentityState(device_id) => {
                let canonical = uuid::Uuid::parse_str(device_id)
                    .map_err(|_| NetworkError::new("DEVICE_ID_INVALID"))?;
                if canonical.to_string() != *device_id {
                    return Err(NetworkError::new("DEVICE_ID_INVALID"));
                }
                (
                    reqwest::Method::GET,
                    format!("/api/agent-network/identity/state?deviceId={device_id}"),
                    true,
                )
            }
            Self::Identity => (
                reqwest::Method::POST,
                "/api/agent-network/identity".into(),
                true,
            ),
            Self::Certificate => (
                reqwest::Method::POST,
                "/api/agent-network/certificate".into(),
                true,
            ),
            Self::Rotate => (
                reqwest::Method::POST,
                "/api/agent-network/identity/rotate".into(),
                true,
            ),
            Self::Challenge => (
                reqwest::Method::POST,
                "/api/agent-network/challenge".into(),
                true,
            ),
            Self::Current => (
                reqwest::Method::POST,
                "/api/agent-network/identity/current".into(),
                true,
            ),
            Self::Jwks => (
                reqwest::Method::GET,
                "/api/agent-network/jwks".into(),
                false,
            ),
        };
        Ok((method, path, authenticated))
    }
}

#[derive(Clone)]
pub(crate) struct NetworkAccountSession {
    session: AuthenticatedSpaceSession,
}
impl NetworkAccountSession {
    pub(crate) fn capture() -> Result<Self, NetworkError> {
        // Space demo fixtures must not mint an actual device/network identity.
        if crate::space_cloud_mock::is_enabled() {
            return Err(NetworkError::new("NETWORK_ACCOUNT_UNAVAILABLE"));
        }
        let session = require_session().map_err(|_| NetworkError::new("SPACE_REAUTH_REQUIRED"))?;
        let origin = url::Url::parse(&session.base_url)
            .map_err(|_| NetworkError::new("NETWORK_ISSUER_INVALID"))?;
        if origin.scheme() != "https" || origin.origin().ascii_serialization() != session.base_url {
            return Err(NetworkError::new("NETWORK_ISSUER_INVALID"));
        }
        Ok(Self { session })
    }
    pub(crate) fn binding_id(&self) -> &str {
        self.session.session_binding_id()
    }
    pub(crate) fn issuer(&self) -> &str {
        &self.session.base_url
    }
    pub(crate) fn principal_id(&self) -> Result<&str, NetworkError> {
        self.session
            .user
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .ok_or_else(|| NetworkError::new("NETWORK_PRINCIPAL_INVALID"))
    }
    pub(crate) fn environment(&self) -> &'static str {
        match space_build_capability().active_environment {
            SpaceEnvironment::Production => "production",
            SpaceEnvironment::Dev => "development",
        }
    }
    pub(crate) fn service_id(&self) -> Result<&'static str, NetworkError> {
        let id = match space_build_capability().active_environment {
            SpaceEnvironment::Production => option_env!("MYAGENTS_AGENT_NETWORK_SERVICE_ID"),
            SpaceEnvironment::Dev => option_env!("MYAGENTS_AGENT_NETWORK_DEV_SERVICE_ID"),
        }
        .ok_or_else(|| NetworkError::new("NETWORK_SERVICE_UNCONFIGURED"))?;
        if uuid::Uuid::parse_str(id)
            .map(|value| value.to_string())
            .as_deref()
            != Ok(id)
        {
            return Err(NetworkError::new("NETWORK_SERVICE_UNCONFIGURED"));
        }
        Ok(id)
    }
    pub(crate) fn ensure_current(&self) -> Result<(), NetworkError> {
        let current = require_session().map_err(|_| NetworkError::new("ACCOUNT_AUTH_REVOKED"))?;
        if current.session_binding_id() != self.binding_id()
            || current.base_url != self.session.base_url
        {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        Ok(())
    }
    pub(crate) async fn request(
        &self,
        operation: AccountOperation,
        body: Option<Value>,
    ) -> Result<Value, NetworkError> {
        self.ensure_current()?;
        let capability = ensure_space_available()
            .map_err(|_| NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", 503))?;
        let (method, path, authenticated) = operation.request()?;
        // This is an external fixed HTTPS origin, with the existing App proxy.
        // Never follow a redirect carrying the opaque user credential.
        #[allow(clippy::disallowed_methods)]
        let builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none());
        let client = crate::proxy_config::build_client_with_proxy(builder)
            .map_err(|_| NetworkError::new("NETWORK_PROXY_INVALID"))?;
        let mut request = with_space_client_context_headers(
            client.request(
                method,
                api_url(self.issuer(), &path)
                    .map_err(|_| NetworkError::new("NETWORK_ISSUER_INVALID"))?,
            ),
            &capability,
        );
        if authenticated {
            request = request.header(
                AUTHORIZATION,
                format!("Bearer {}", self.session.session_token()),
            );
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", 503))?;
        let status = response.status();
        let retry_after = crate::agent_network::reconnect::retry_after(&response);
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", 503))?
        {
            if bytes.len() + chunk.len() > 65_536 {
                return Err(NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID"));
            }
            bytes.extend_from_slice(&chunk);
        }
        self.ensure_current()?;
        let envelope: CloudEnvelope<Value> = serde_json::from_slice(&bytes)
            .map_err(|_| { let mut error = NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID"); error.retry_after = retry_after; error })?;
        if !status.is_success() || !envelope.success {
            let code = envelope
                .code
                .as_deref()
                .unwrap_or("NETWORK_ACCOUNT_UNAVAILABLE");
            // Proof/certificate 401 is distinct from loss of the original login.
            if status == reqwest::StatusCode::UNAUTHORIZED
                && ["SPACE_REAUTH_REQUIRED", "NOT_AUTHENTICATED"].contains(&code)
            {
                if mark_user_session_reauth_required(&self.session)
                    .await
                    .map_err(|_| NetworkError::new("SPACE_SESSION_STATE_WRITE_FAILED"))?
                {
                    account_user_session_invalidated();
                }
            }
            let mut error = NetworkError::cloud(code, status.as_u16());
            error.retry_after = retry_after;
            return Err(error);
        }
        envelope
            .data
            .ok_or_else(|| NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID"))
    }
}
