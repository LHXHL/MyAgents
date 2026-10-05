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
use std::sync::Arc;
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
    keys: VerificationKeyCache,
}

struct CachedVerificationKeys {
    keys: JwkSet,
    last_refresh: Instant,
}

/// Public signing keys belong to this verifier lifecycle. Channel jobs clone
/// the verifier, so their refresh must update the same cache and deadline.
#[derive(Clone)]
struct VerificationKeyCache {
    shared: Arc<tokio::sync::Mutex<CachedVerificationKeys>>,
}
impl VerificationKeyCache {
    fn new(keys: JwkSet) -> Self {
        Self {
            shared: Arc::new(tokio::sync::Mutex::new(CachedVerificationKeys {
                keys,
                last_refresh: Instant::now(),
            })),
        }
    }

    async fn keys_for(
        &self,
        kid: &str,
        load: impl std::future::Future<Output = Result<Value, NetworkError>>,
    ) -> Result<JwkSet, NetworkError> {
        let mut cached = self.shared.lock().await;
        // Recheck after acquiring the lock. Concurrent channel checks share one
        // refresh; a failed/cancelled load leaves the prior state unchanged.
        if cached.last_refresh.elapsed() >= Duration::from_secs(60)
            || (cached.keys.find(kid).is_none()
                && cached.last_refresh.elapsed() >= Duration::from_secs(1))
        {
            let keys = checked_jwks(load.await?)?;
            cached.keys = keys;
            cached.last_refresh = Instant::now();
        }
        Ok(cached.keys.clone())
    }
}

impl AccountVerifier {
    pub(crate) async fn new(account: NetworkAccountSession) -> Result<Self, NetworkError> {
        let keys = checked_jwks(account.request(AccountOperation::Jwks, None).await?)?;
        Ok(Self {
            account,
            keys: VerificationKeyCache::new(keys),
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
        let keys = self
            .keys
            .keys_for(kid, self.account.request(AccountOperation::Jwks, None))
            .await?;
        // A shared refresh can wait behind another channel job. That wait does
        // not grant authority to an account binding that changed meanwhile.
        self.account.ensure_current()?;
        verify_with_keys(
            self.account.issuer(),
            audience,
            typ,
            max_lifetime,
            token,
            &keys,
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

    async fn age_cache(cache: &VerificationKeyCache, seconds: u64) {
        cache.shared.lock().await.last_refresh = Instant::now() - Duration::from_secs(seconds);
    }

    #[tokio::test]
    async fn cloned_channel_verifiers_share_one_expired_key_refresh() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let (_, public) = fixture();
        let cache = VerificationKeyCache::new(checked_jwks(public.clone()).unwrap());
        age_cache(&cache, 61).await;
        let first = cache.clone();
        let second = cache.clone();
        let loads = AtomicUsize::new(0);
        let load = || async {
            loads.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(public.clone())
        };
        let (first_keys, second_keys) = tokio::join!(
            first.keys_for("isolated-key", load()),
            second.keys_for("isolated-key", load()),
        );
        assert!(first_keys.unwrap().find("isolated-key").is_some());
        assert!(second_keys.unwrap().find("isolated-key").is_some());
        cache.keys_for("isolated-key", load()).await.unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_clone_shares_rotated_keys_and_unknown_key_refresh_cooldown() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let (_, original) = fixture();
        let (_, mut rotated) = fixture();
        rotated["keys"][0]["kid"] = json!("rotated-key");
        let cache = VerificationKeyCache::new(checked_jwks(original).unwrap());
        age_cache(&cache, 2).await;
        let channel = cache.clone();
        let loads = AtomicUsize::new(0);
        let load = || async {
            loads.fetch_add(1, Ordering::SeqCst);
            Ok(rotated.clone())
        };
        let refreshed = channel.keys_for("rotated-key", load()).await.unwrap();
        assert!(refreshed.find("rotated-key").is_some());
        assert!(refreshed.find("isolated-key").is_none());
        assert!(cache
            .keys_for("rotated-key", load())
            .await
            .unwrap()
            .find("rotated-key")
            .is_some());
        // Repeated unrecognized keys cannot cause a refresh per verification.
        assert!(cache
            .keys_for("unknown-key", load())
            .await
            .unwrap()
            .find("unknown-key")
            .is_none());
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_and_invalid_refreshes_preserve_state_and_allow_recovery() {
        let (_, public) = fixture();
        let cache = VerificationKeyCache::new(checked_jwks(public.clone()).unwrap());
        age_cache(&cache, 61).await;
        let original_refresh = cache.shared.lock().await.last_refresh;
        let channel = cache.clone();
        let failed = channel
            .keys_for("isolated-key", async {
                Err(NetworkError::cloud("ACCOUNT_SERVICE_UNAVAILABLE", 503))
            })
            .await;
        assert_eq!(failed.unwrap_err().code, "ACCOUNT_SERVICE_UNAVAILABLE");
        let invalid = channel
            .keys_for("isolated-key", async { Ok(json!({ "keys": [] })) })
            .await;
        assert_eq!(invalid.unwrap_err().code, "NETWORK_SIGNED_IDENTITY_INVALID");
        {
            let prior = cache.shared.lock().await;
            assert_eq!(prior.last_refresh, original_refresh);
            assert!(prior.keys.find("isolated-key").is_some());
        }
        assert!(cache
            .keys_for("isolated-key", async { Ok(public) })
            .await
            .unwrap()
            .find("isolated-key")
            .is_some());
        assert!(cache.shared.lock().await.last_refresh > original_refresh);
    }

    #[tokio::test]
    async fn cancelled_channel_refresh_releases_the_shared_cache() {
        let (_, public) = fixture();
        let cache = VerificationKeyCache::new(checked_jwks(public.clone()).unwrap());
        age_cache(&cache, 61).await;
        let original_refresh = cache.shared.lock().await.last_refresh;
        let channel = cache.clone();
        let mut loading = Box::pin(channel.keys_for("isolated-key", std::future::pending()));
        assert!(futures_util::poll!(loading.as_mut()).is_pending());
        drop(loading);
        assert_eq!(cache.shared.lock().await.last_refresh, original_refresh);
        let recovered = tokio::time::timeout(
            Duration::from_secs(1),
            cache.keys_for("isolated-key", async { Ok(public) }),
        )
        .await
        .expect("a cancelled job must release the refresh lock")
        .unwrap();
        assert!(recovered.find("isolated-key").is_some());
    }

    #[tokio::test]
    async fn separately_created_verifier_scopes_do_not_share_keys_or_deadlines() {
        let (_, public) = fixture();
        let (_, mut rotated) = fixture();
        rotated["keys"][0]["kid"] = json!("another-scope-key");
        let first = VerificationKeyCache::new(checked_jwks(public.clone()).unwrap());
        let other = VerificationKeyCache::new(checked_jwks(public).unwrap());
        age_cache(&first, 61).await;
        first
            .keys_for("another-scope-key", async { Ok(rotated) })
            .await
            .unwrap();
        let untouched = other
            .keys_for("isolated-key", async {
                panic!("a fresh independent scope must not load keys")
            })
            .await
            .unwrap();
        assert!(untouched.find("isolated-key").is_some());
        assert!(untouched.find("another-scope-key").is_none());
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
