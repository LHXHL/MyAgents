//! Mature JOSE verification with a single fixed account key source. All token
//! bodies additionally pass the shared closed application schemas.
use super::crypto::{certificate_chain, certificate_fingerprint};
use super::NetworkError;
use crate::space_cloud::agent_network::{AccountOperation, NetworkAccountSession};
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use myagents_agent_network_protocol::{budget, PeerBinding};
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyConfirmation {
    pub jkt: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub iat: u64,
    pub nbf: u64,
    pub exp: u64,
    pub jti: String,
    pub environment: String,
    pub device_id: String,
    pub key_generation: u64,
    pub session_handle: String,
    pub cnf: KeyConfirmation,
}
pub struct Bootstrap {
    pub access: AccessClaims,
    pub network_url: String,
    pub root_certificate: String,
}

#[derive(Clone)]
pub(crate) struct VerifiedPeer {
    binding: PeerBinding,
}
impl std::ops::Deref for VerifiedPeer {
    type Target = PeerBinding;
    fn deref(&self) -> &PeerBinding {
        &self.binding
    }
}
impl VerifiedPeer {
    #[cfg(test)]
    pub(crate) fn fixture(binding: PeerBinding) -> Self {
        Self { binding }
    }
}

#[derive(Clone)]
pub(crate) struct AccountVerifier {
    account: NetworkAccountSession,
    keys: JwkSet,
    last_refresh: Instant,
}
impl AccountVerifier {
    pub(crate) async fn new(account: NetworkAccountSession) -> Result<Self, NetworkError> {
        let keys = checked_jwks(account.request(AccountOperation::Jwks, None).await?)?;
        Ok(Self {
            account,
            keys,
            last_refresh: Instant::now(),
        })
    }
    async fn verify(
        &mut self,
        token: &str,
        typ: &str,
        audience: &str,
        max_lifetime: usize,
    ) -> Result<Value, NetworkError> {
        self.account.ensure_current()?;
        let header = checked_header(token, typ)?;
        let kid = header.kid.as_deref().ok_or_else(invalid_token)?;
        // One bounded unknown-kid refresh; token contents can never select a URL.
        if self.last_refresh.elapsed() >= Duration::from_secs(60)
            || (self.keys.find(kid).is_none()
                && self.last_refresh.elapsed() >= Duration::from_secs(1))
        {
            self.keys = checked_jwks(self.account.request(AccountOperation::Jwks, None).await?)?;
            self.last_refresh = Instant::now();
        }
        verify_with_keys(
            self.account.issuer(),
            audience,
            typ,
            max_lifetime,
            token,
            &self.keys,
        )
    }
    pub(crate) async fn access(&mut self, token: &str) -> Result<AccessClaims, NetworkError> {
        let service = self.account.service_id()?;
        let value = self
            .verify(
                token,
                "ma-network-access+jwt",
                service,
                budget("tokenSeconds"),
            )
            .await?;
        myagents_agent_network_protocol::validate_access(&value).map_err(|_| invalid_token())?;
        let access: AccessClaims = serde_json::from_value(value).map_err(|_| invalid_token())?;
        self.own_scope(&access)?;
        Ok(access)
    }
    fn own_scope(&self, claims: &AccessClaims) -> Result<(), NetworkError> {
        if claims.sub != self.account.principal_id()?
            || claims.environment != self.account.environment()
            || claims.aud != self.account.service_id()?
        {
            return Err(invalid_token());
        }
        Ok(())
    }
    pub(crate) async fn bootstrap(&mut self, token: &str) -> Result<Bootstrap, NetworkError> {
        let service = self.account.service_id()?;
        let mut value = self
            .verify(
                token,
                "ma-network-bootstrap+jwt",
                service,
                budget("tokenSeconds"),
            )
            .await?;
        myagents_agent_network_protocol::validate_bootstrap(&value).map_err(|_| invalid_token())?;
        let object = value.as_object_mut().ok_or_else(invalid_token)?;
        let network_url = object
            .remove("networkUrl")
            .and_then(|item| item.as_str().map(str::to_owned))
            .ok_or_else(invalid_token)?;
        let root_certificate = object
            .remove("rootCertificate")
            .and_then(|item| item.as_str().map(str::to_owned))
            .ok_or_else(invalid_token)?;
        let endpoint = url::Url::parse(&network_url).map_err(|_| invalid_token())?;
        if endpoint.scheme() != "https" || endpoint.origin().ascii_serialization() != network_url {
            return Err(invalid_token());
        }
        let access: AccessClaims = serde_json::from_value(value).map_err(|_| invalid_token())?;
        self.own_scope(&access)?;
        certificate_chain(&root_certificate)?;
        Ok(Bootstrap {
            access,
            network_url,
            root_certificate,
        })
    }
    pub(crate) async fn peer(&mut self, token: &str) -> Result<VerifiedPeer, NetworkError> {
        let value = self
            .verify(
                token,
                "ma-network-peer+jwt",
                "myagents-agent-peer",
                budget("certificateSeconds") + budget("clockSkewSeconds"),
            )
            .await?;
        myagents_agent_network_protocol::validate_signed_peer(&value)
            .map_err(|_| invalid_token())?;
        let binding: PeerBinding =
            serde_json::from_value(value["binding"].clone()).map_err(|_| invalid_token())?;
        if binding.principal_id != value["sub"]
            || binding.expires_at != value["exp"]
            || binding.principal_id != self.account.principal_id()?
            || binding.service_id != self.account.service_id()?
            || binding.environment != self.account.environment()
            || binding.san
                != format!(
                    "{}.devices.{}.invalid",
                    binding.identity_binding_id, binding.service_id
                )
        {
            return Err(invalid_token());
        }
        let certs = certificate_chain(&binding.certificate)?;
        if certs.len() != 1 || certificate_fingerprint(&certs[0]) != binding.certificate_fingerprint
        {
            return Err(invalid_token());
        }
        Ok(VerifiedPeer { binding })
    }
}
fn invalid_token() -> NetworkError {
    NetworkError::new("NETWORK_SIGNED_IDENTITY_INVALID")
}
fn checked_header(token: &str, typ: &str) -> Result<jsonwebtoken::Header, NetworkError> {
    if token.is_empty() || token.len() > 32_768 {
        return Err(invalid_token());
    }
    let header = decode_header(token).map_err(|_| invalid_token())?;
    // Re-serialize the mature library's parsed header to reject all extensions,
    // critical claims, remote key URLs and alternate embedded key material.
    let fields = serde_json::to_value(&header).map_err(|_| invalid_token())?;
    if header.alg != Algorithm::ES256
        || header.typ.as_deref() != Some(typ)
        || header
            .kid
            .as_deref()
            .is_none_or(|kid| kid.is_empty() || kid.len() > 256)
        || !fields
            .as_object()
            .ok_or_else(invalid_token)?
            .keys()
            .all(|key| ["alg", "typ", "kid"].contains(&key.as_str()))
    {
        return Err(invalid_token());
    }
    Ok(header)
}
fn checked_jwks(value: Value) -> Result<JwkSet, NetworkError> {
    let object = value.as_object().ok_or_else(invalid_token)?;
    if object.len() != 1 {
        return Err(invalid_token());
    }
    let keys = object
        .get("keys")
        .and_then(Value::as_array)
        .ok_or_else(invalid_token)?;
    if keys.is_empty() || keys.len() > 16 {
        return Err(invalid_token());
    }
    let mut ids = std::collections::HashSet::new();
    for key in keys {
        let fields = key.as_object().ok_or_else(invalid_token)?;
        if fields.len() != 7
            || !fields
                .keys()
                .all(|key| ["kty", "crv", "x", "y", "kid", "alg", "use"].contains(&key.as_str()))
            || key["kty"] != "EC"
            || key["crv"] != "P-256"
            || key["alg"] != "ES256"
            || key["use"] != "sig"
            || !ids.insert(
                key["kid"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 256)
                    .ok_or_else(invalid_token)?,
            )
        {
            return Err(invalid_token());
        }
    }
    serde_json::from_value(value).map_err(|_| invalid_token())
}
fn verify_with_keys(
    issuer: &str,
    audience: &str,
    typ: &str,
    max_lifetime: usize,
    token: &str,
    keys: &JwkSet,
) -> Result<Value, NetworkError> {
    let header = checked_header(token, typ)?;
    let jwk = keys
        .find(header.kid.as_deref().ok_or_else(invalid_token)?)
        .ok_or_else(invalid_token)?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| invalid_token())?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[audience]);
    validation.set_required_spec_claims(&["iss", "aud", "sub", "exp", "nbf"]);
    validation.validate_nbf = true;
    validation.leeway = budget("clockSkewSeconds") as u64;
    let value = decode::<Value>(token, &key, &validation)
        .map_err(|_| invalid_token())?
        .claims;
    let iat = value["iat"].as_u64().ok_or_else(invalid_token)?;
    let exp = value["exp"].as_u64().ok_or_else(invalid_token)?;
    let now = jsonwebtoken::get_current_timestamp();
    if exp <= iat
        || exp - iat > max_lifetime as u64
        || iat > now + validation.leeway
        || now.saturating_sub(iat) > max_lifetime as u64 + validation.leeway
    {
        return Err(invalid_token());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use p256::{ecdsa::SigningKey, pkcs8::DecodePrivateKey};
    use serde_json::json;
    fn fixture() -> (jsonwebtoken::EncodingKey, Value) {
        let pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let private = pair.serialize_der();
        let signing = SigningKey::from_pkcs8_der(&private).unwrap();
        let point = signing.verifying_key().to_encoded_point(false);
        (
            jsonwebtoken::EncodingKey::from_ec_der(&private),
            json!({"keys":[{"kty":"EC","crv":"P-256",
          "x":URL_SAFE_NO_PAD.encode(point.x().unwrap()),"y":URL_SAFE_NO_PAD.encode(point.y().unwrap()),
          "alg":"ES256","use":"sig","kid":"isolated-key"}]}),
        )
    }
    #[test]
    fn network_jws_uses_fixed_trust_source_type_and_claim_budgets() {
        let (key, public) = fixture();
        let keys = checked_jwks(public).unwrap();
        let issuer = "https://isolated.myagents.invalid";
        let audience = "00000000-0000-4000-8000-000000000001";
        let typ = "ma-network-access+jwt";
        let now = jsonwebtoken::get_current_timestamp();
        let mut claims = json!({"iss":issuer,"aud":audience,"sub":"owner","iat":now,"nbf":now,"exp":now+300,
          "jti":"00000000-0000-4000-8000-000000000002","environment":"development",
          "deviceId":"00000000-0000-4000-8000-000000000003","keyGeneration":1,
          "sessionHandle":"00000000-0000-4000-8000-000000000004","cnf":{"jkt":URL_SAFE_NO_PAD.encode([42u8;32])}});
        let mut header = jsonwebtoken::Header::new(Algorithm::ES256);
        header.typ = Some(typ.into());
        header.kid = Some("isolated-key".into());
        let token = jsonwebtoken::encode(&header, &claims, &key).unwrap();
        let value = verify_with_keys(issuer, audience, typ, 300, &token, &keys).unwrap();
        myagents_agent_network_protocol::validate_access(&value).unwrap();
        assert!(
            verify_with_keys("https://other.invalid", audience, typ, 300, &token, &keys).is_err()
        );
        assert!(verify_with_keys(issuer, "another-service", typ, 300, &token, &keys).is_err());
        assert!(verify_with_keys(
            issuer,
            audience,
            "ma-network-bootstrap+jwt",
            300,
            &token,
            &keys
        )
        .is_err());
        for (injected, value) in [
            ("jku", json!("https://untrusted.invalid")),
            ("x5u", json!("https://untrusted.invalid")),
            ("jwk", serde_json::to_value(&keys.keys[0]).unwrap()),
            ("x5c", json!(["untrusted"])),
            ("crit", json!(["b64"])),
            ("b64", json!(false)),
        ] {
            let mut altered = serde_json::to_value(&header).unwrap();
            altered[injected] = value;
            let altered: jsonwebtoken::Header = serde_json::from_value(altered).unwrap();
            let signed = jsonwebtoken::encode(&altered, &claims, &key).unwrap();
            assert!(verify_with_keys(issuer, audience, typ, 300, &signed, &keys).is_err());
        }
        claims["exp"] = json!(now + 301);
        assert!(verify_with_keys(
            issuer,
            audience,
            typ,
            300,
            &jsonwebtoken::encode(&header, &claims, &key).unwrap(),
            &keys
        )
        .is_err());
        claims["exp"] = json!(now + 300);
        claims["unexpectedAccountAuthority"] = json!("other");
        let value = verify_with_keys(
            issuer,
            audience,
            typ,
            300,
            &jsonwebtoken::encode(&header, &claims, &key).unwrap(),
            &keys,
        )
        .unwrap();
        assert!(myagents_agent_network_protocol::validate_access(&value).is_err());
    }
    #[test]
    fn network_jwks_rejects_private_material_duplicates_and_alternate_algorithms() {
        let (_, public) = fixture();
        let mut private = public.clone();
        private["keys"][0]["d"] = json!("private-not-allowed");
        assert!(checked_jwks(private).is_err());
        let mut duplicate = public.clone();
        duplicate["keys"]
            .as_array_mut()
            .unwrap()
            .push(public["keys"][0].clone());
        assert!(checked_jwks(duplicate).is_err());
        let mut alternate = public.clone();
        alternate["keys"][0]["alg"] = json!("HS256");
        assert!(checked_jwks(alternate).is_err());
    }
}
