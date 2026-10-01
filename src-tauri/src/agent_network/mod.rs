//! App-owned network identity, transport and admission adapters.
pub(crate) mod actor;
mod calls;
mod catalog;
mod channel;
pub(crate) mod commands;
mod crypto;
pub(crate) mod discovery;
mod identity;
mod incoming;
mod jwt;
mod local_owner;
mod memory;
mod pairs;
mod policy;
mod power;
pub(crate) mod returns;
pub(crate) mod source;
mod transport;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkError {
    pub code: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}
impl NetworkError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self {
            code: code.into(),
            retryable: false,
            details: None,
        }
    }
    pub(crate) fn cloud(code: &str, status: u16) -> Self {
        let safe = !code.is_empty()
            && code.len() <= 128
            && code
                .bytes()
                .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit() || value == b'_');
        Self {
            code: if safe {
                code.into()
            } else {
                "NETWORK_ACCOUNT_UNAVAILABLE".into()
            },
            retryable: status == 429 || status >= 500,
            details: None,
        }
    }
}
impl std::fmt::Display for NetworkError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}
impl std::error::Error for NetworkError {}
impl From<crypto::CryptoError> for NetworkError {
    fn from(error: crypto::CryptoError) -> Self {
        Self {
            code: error.to_string(),
            retryable: false,
            details: None,
        }
    }
}
