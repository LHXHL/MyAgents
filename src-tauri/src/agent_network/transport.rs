//! Fixed signed network origin, public TLS + device DPoP and App proxy.
//! No user account credential ever enters this client.
use super::crypto::{external_tls_config, DevicePrivateKey};
use super::NetworkError;
use myagents_agent_network_protocol::{budget, validate_metadata, MetadataKind};
use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde::Deserialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_tungstenite::{
    tungstenite::{
        handshake::{client::generate_key, derive_accept_key},
        protocol::{Role, WebSocketConfig},
    },
    WebSocketStream,
};

pub(crate) type NetworkSocket = WebSocketStream<reqwest::Upgraded>;
pub(crate) struct NetworkTransport {
    memory: super::memory::MemoryBudget,
    origin: url::Url,
    client: reqwest::Client,
    key: Arc<DevicePrivateKey>,
    nonce: Mutex<Option<String>>,
}
impl NetworkTransport {
    pub(crate) fn new(
        origin: &str,
        key: Arc<DevicePrivateKey>,
        memory: super::memory::MemoryBudget,
    ) -> Result<Self, NetworkError> {
        let endpoint =
            url::Url::parse(origin).map_err(|_| NetworkError::new("NETWORK_ENDPOINT_INVALID"))?;
        if endpoint.scheme() != "https" || endpoint.origin().ascii_serialization() != origin {
            return Err(NetworkError::new("NETWORK_ENDPOINT_INVALID"));
        }
        // External HTTPS endpoint with standard public platform verification.
        // The inner device CA is intentionally absent from this trust store.
        #[allow(clippy::disallowed_methods)]
        let builder = reqwest::Client::builder()
            .http1_only()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .tls_backend_preconfigured(external_tls_config()?);
        let client = crate::proxy_config::build_client_with_proxy(builder)
            .map_err(|_| NetworkError::new("NETWORK_PROXY_INVALID"))?;
        Ok(Self {
            memory,
            origin: endpoint,
            client,
            key,
            nonce: Mutex::new(None),
        })
    }
    async fn authenticated(
        &self,
        request: reqwest::RequestBuilder,
        method: &reqwest::Method,
        url: &url::Url,
        token: &str,
    ) -> Result<reqwest::Response, NetworkError> {
        for attempt in 0..2 {
            let nonce = self
                .nonce
                .lock()
                .map_err(|_| NetworkError::new("NETWORK_PROOF_INVALID"))?
                .clone();
            let mut proof = HeaderValue::from_str(&self.key.dpop(
                method.as_str(),
                url,
                token,
                nonce.as_deref(),
            )?)
            .map_err(|_| NetworkError::new("NETWORK_PROOF_INVALID"))?;
            proof.set_sensitive(true);
            let response = request
                .try_clone()
                .ok_or_else(|| NetworkError::new("NETWORK_REQUEST_INVALID"))?
                .header(AUTHORIZATION, bearer(token)?)
                .header("DPoP", proof)
                .send()
                .await
                .map_err(|_| NetworkError::new("NETWORK_TRANSPORT_FAILED"))?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                if let Some(nonce) = response
                    .headers()
                    .get("DPoP-Nonce")
                    .and_then(|n| n.to_str().ok())
                    .filter(|n| !n.is_empty() && n.len() <= 256)
                {
                    *self
                        .nonce
                        .lock()
                        .map_err(|_| NetworkError::new("NETWORK_PROOF_INVALID"))? =
                        Some(nonce.to_owned());
                    // The nonce challenge precedes dispatch; no uncertain
                    // application mutation or failed transport is retried.
                    continue;
                }
            }
            return Ok(response);
        }
        Err(NetworkError::new("NETWORK_PROOF_INVALID"))
    }
    pub(crate) async fn json(
        &self,
        route: NetworkRoute<'_>,
        token: &str,
        body: Option<Value>,
    ) -> Result<Value, NetworkError> {
        Ok(self.json_owned(route, token, body).await?.0)
    }
    pub(crate) async fn json_owned(
        &self,
        route: NetworkRoute<'_>,
        token: &str,
        body: Option<Value>,
    ) -> Result<(Value, super::memory::Allocation), NetworkError> {
        let mut allocation = self.memory.reserve(0)?;
        let (method, path) = route.path()?;
        let url = self
            .origin
            .join(&path)
            .map_err(|_| NetworkError::new("NETWORK_ENDPOINT_INVALID"))?;
        let mut request = self.client.request(method.clone(), url.clone());
        if let Some(body) = body {
            allocation.resize(super::memory::measure(&body)?.0 * 2)?;
            let bytes = serde_json::to_vec(&body)
                .map_err(|_| NetworkError::new("NETWORK_REQUEST_INVALID"))?;
            if bytes.len() > budget("catalogBytes") {
                return Err(NetworkError::new("MESSAGE_TOO_LARGE"));
            }
            request = request
                .header("Content-Type", "application/json")
                .body(bytes);
        }
        let mut response = self.authenticated(request, &method, &url, token).await?;
        allocation.resize(0)?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| NetworkError::new("NETWORK_TRANSPORT_FAILED"))?
        {
            if bytes.len() + chunk.len() > budget("catalogBytes") {
                return Err(NetworkError::new("MESSAGE_TOO_LARGE"));
            }
            allocation.resize((bytes.len() + chunk.len()) * 2)?;
            bytes
                .try_reserve_exact(chunk.len())
                .map_err(|_| NetworkError::new("CONNECTOR_CAPACITY"))?;
            bytes.extend_from_slice(&chunk);
        }
        #[derive(Deserialize)]
        struct Envelope {
            ok: bool,
            data: Option<Value>,
            error: Option<Failure>,
        }
        #[derive(Deserialize)]
        struct Failure {
            code: String,
            retryable: bool,
            details: Option<Value>,
        }
        let result: Envelope = serde_json::from_slice(&bytes)
            .map_err(|_| NetworkError::new("NETWORK_RESPONSE_INVALID"))?;
        if !status.is_success() || !result.ok {
            let failure = result
                .error
                .ok_or_else(|| NetworkError::new("NETWORK_RESPONSE_INVALID"))?;
            let mut error = NetworkError::cloud(&failure.code, status.as_u16());
            error.retryable =
                failure.retryable && (status.as_u16() == 429 || status.is_server_error());
            error.details = failure.details;
            return Err(error);
        }
        let value = result
            .data
            .ok_or_else(|| NetworkError::new("NETWORK_RESPONSE_INVALID"))?;
        validate_metadata(route.response_kind(), &value)
            .map_err(|_| NetworkError::new("NETWORK_RESPONSE_INVALID"))?;
        Ok((value, allocation))
    }
    pub(crate) async fn websocket(&self, token: &str) -> Result<NetworkSocket, NetworkError> {
        let key = generate_key();
        let url = self
            .origin
            .join("/v1/ws")
            .map_err(|_| NetworkError::new("NETWORK_ENDPOINT_INVALID"))?;
        let request = self
            .client
            .get(url.clone())
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Key", &key)
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Protocol", "myagents-agent-network.v1");
        let response = self
            .authenticated(request, &reqwest::Method::GET, &url, token)
            .await?;
        let headers = response.headers();
        let get = |key: &str| headers.get(key).and_then(|value| value.to_str().ok());
        if response.status() != reqwest::StatusCode::SWITCHING_PROTOCOLS
            || response.version() != reqwest::Version::HTTP_11
            || !get("Upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
            || !get("Connection").is_some_and(|value| {
                value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
            || get("Sec-WebSocket-Accept") != Some(derive_accept_key(key.as_bytes()).as_str())
            || get("Sec-WebSocket-Protocol") != Some("myagents-agent-network.v1")
            || headers.contains_key("Sec-WebSocket-Extensions")
        {
            return Err(NetworkError::new("NETWORK_UPGRADE_REJECTED"));
        }
        let stream = response
            .upgrade()
            .await
            .map_err(|_| NetworkError::new("NETWORK_UPGRADE_REJECTED"))?;
        let config = WebSocketConfig {
            write_buffer_size: 0,
            max_write_buffer_size: budget("socketQueueBytes"),
            max_message_size: Some(budget("controlBytes") + 22),
            max_frame_size: Some(budget("controlBytes") + 22),
            accept_unmasked_frames: false,
            ..Default::default()
        };
        Ok(WebSocketStream::from_raw_socket(stream, Role::Client, Some(config)).await)
    }
}
fn bearer(token: &str) -> Result<HeaderValue, NetworkError> {
    if token.len() > 32_768 {
        return Err(NetworkError::new("NETWORK_TOKEN_INVALID"));
    }
    let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| NetworkError::new("NETWORK_TOKEN_INVALID"))?;
    value.set_sensitive(true);
    Ok(value)
}
fn uuid(value: &str) -> Result<&str, NetworkError> {
    if uuid::Uuid::parse_str(value)
        .map(|id| id.to_string())
        .as_deref()
        != Ok(value)
    {
        return Err(NetworkError::new("NETWORK_REFERENCE_INVALID"));
    }
    Ok(value)
}
fn page(cursor: Option<&str>, limit: usize) -> Result<String, NetworkError> {
    if limit == 0 || limit > budget("pageMax") {
        return Err(NetworkError::new("PAGE_LIMIT_INVALID"));
    }
    Ok(match cursor {
        Some(cursor) => format!("?limit={limit}&cursor={}", uuid(cursor)?),
        None => format!("?limit={limit}"),
    })
}
pub(crate) enum NetworkRoute<'a> {
    Network,
    Devices {
        cursor: Option<&'a str>,
        limit: usize,
    },
    Agents {
        device_id: &'a str,
        cursor: Option<&'a str>,
        limit: usize,
    },
    Callable {
        network_id: &'a str,
        cursor: Option<&'a str>,
        limit: usize,
    },
    Catalog,
    Resolve {
        network_id: &'a str,
        mount_id: &'a str,
    },
    Membership {
        network_id: &'a str,
        device_id: &'a str,
        joined: bool,
    },
    Mount {
        network_id: &'a str,
        mount_id: &'a str,
    },
    Receipt {
        mutation_id: &'a str,
    },
}
impl NetworkRoute<'_> {
    fn response_kind(&self) -> MetadataKind {
        match self {
            Self::Network => MetadataKind::Network,
            Self::Devices { .. } => MetadataKind::Devices,
            Self::Agents { .. } => MetadataKind::Agents,
            Self::Callable { .. } => MetadataKind::Callable,
            Self::Catalog => MetadataKind::Catalog,
            Self::Membership { .. } => MetadataKind::Membership,
            Self::Resolve { .. } => MetadataKind::CallableAgent,
            Self::Mount { .. } => MetadataKind::Mount,
            Self::Receipt { .. } => MetadataKind::Receipt,
        }
    }
    fn path(&self) -> Result<(reqwest::Method, String), NetworkError> {
        Ok(match self {
            Self::Network => (reqwest::Method::GET, "/v1/me/network".into()),
            Self::Devices { cursor, limit } => (
                reqwest::Method::GET,
                format!("/v1/devices{}", page(*cursor, *limit)?),
            ),
            Self::Agents {
                device_id,
                cursor,
                limit,
            } => (
                reqwest::Method::GET,
                format!(
                    "/v1/devices/{}/agents{}",
                    uuid(device_id)?,
                    page(*cursor, *limit)?
                ),
            ),
            Self::Callable {
                network_id,
                cursor,
                limit,
            } => (
                reqwest::Method::GET,
                format!(
                    "/v1/networks/{}/callable-agents{}",
                    uuid(network_id)?,
                    page(*cursor, *limit)?
                ),
            ),
            Self::Catalog => (reqwest::Method::PUT, "/v1/devices/self/catalog".into()),
            Self::Resolve {
                network_id,
                mount_id,
            } => (
                reqwest::Method::GET,
                format!(
                    "/v1/networks/{}/callable-agents/{}",
                    uuid(network_id)?,
                    uuid(mount_id)?
                ),
            ),
            Self::Membership {
                network_id,
                device_id,
                joined,
            } => (
                reqwest::Method::POST,
                format!(
                    "/v1/networks/{}/devices/{}/{}",
                    uuid(network_id)?,
                    uuid(device_id)?,
                    if *joined { "join" } else { "leave" }
                ),
            ),
            Self::Mount {
                network_id,
                mount_id,
            } => (
                reqwest::Method::PATCH,
                format!(
                    "/v1/networks/{}/mounts/{}",
                    uuid(network_id)?,
                    uuid(mount_id)?
                ),
            ),
            Self::Receipt { mutation_id } => (
                reqwest::Method::GET,
                format!("/v1/mutations/{}", uuid(mutation_id)?),
            ),
        })
    }
}
