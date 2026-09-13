//! A deliberately finite native API client. OAuth state and credential contents
//! belong to CLIProxy; no token document or generic management API is exposed.
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::types::{Error, Result};

#[derive(Clone)]
pub(super) struct Client {
    http: reqwest::Client,
    base_url: String,
    management_key: String,
    model_key: String,
}

#[derive(Deserialize)]
pub(super) struct AuthUrl {
    pub url: String,
    pub state: String,
}

#[derive(Clone, Deserialize)]
pub(super) struct Account {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub email: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}

impl Client {
    pub fn new(port: u16, management_key: String, model_key: String) -> Result<Self> {
        let http = crate::local_http::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::new("local_http", "无法创建组件连接"))?;
        Ok(Self {
            http,
            base_url: format!("http://127.0.0.1:{port}"),
            management_key,
            model_key,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
    pub fn model_key(&self) -> &str {
        &self.model_key
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        query: &[(&str, &str)],
    ) -> Result<Value> {
        let mut url = reqwest::Url::parse(&format!("{}{path}", self.base_url))
            .map_err(|_| Error::contract())?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        let mut request = self.http.request(method, url);
        if path.starts_with("/v0/management/") {
            request = request.bearer_auth(&self.management_key);
        } else if path == "/v1/models" {
            request = request.bearer_auth(&self.model_key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        // Do not include reqwest errors, response text or request URLs: OAuth
        // query strings and native diagnostics can contain account secrets.
        let response = request
            .send()
            .await
            .map_err(|_| Error::new("transport_outcome_unknown", "组件请求结果尚未确认"))?;
        bounded_json(response).await
    }

    pub async fn health(&self) -> Result<()> {
        self.request(reqwest::Method::GET, "/healthz", None, &[])
            .await?;
        Ok(())
    }

    /// This GET creates a native OAuth session. The caller must never retry it
    /// on transport failure: only tearing down this candidate ends ambiguity.
    pub async fn auth_url(&self) -> Result<AuthUrl> {
        let value = self
            .request(
                reqwest::Method::GET,
                "/v0/management/antigravity-auth-url",
                None,
                &[],
            )
            .await?;
        serde_json::from_value(value).map_err(|_| Error::contract())
    }

    pub async fn callback(
        &self,
        state: &str,
        code: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        self.request(reqwest::Method::POST, "/v0/management/oauth-callback", Some(json!({
            "provider": "antigravity", "state": state, "code": code.unwrap_or(""), "error": error.unwrap_or("")
        })), &[]).await?;
        Ok(())
    }

    pub async fn auth_status(&self, state: &str) -> Result<String> {
        if state.is_empty() {
            return Err(Error::contract());
        }
        let value = self
            .request(
                reqwest::Method::GET,
                "/v0/management/get-auth-status",
                None,
                &[("state", state)],
            )
            .await?;
        match value.get("status").and_then(Value::as_str) {
            Some(status @ ("wait" | "ok" | "error")) => Ok(status.to_owned()),
            _ => Err(Error::contract()),
        }
    }

    pub async fn cancel_oauth(&self, state: &str) -> Result<()> {
        if state.is_empty() {
            return Err(Error::contract());
        }
        self.request(
            reqwest::Method::DELETE,
            "/v0/management/oauth-session",
            None,
            &[("state", state)],
        )
        .await?;
        Ok(())
    }

    pub async fn account(&self) -> Result<Option<Account>> {
        let value = self
            .request(reqwest::Method::GET, "/v0/management/auth-files", None, &[])
            .await?;
        let files = value
            .get("files")
            .and_then(Value::as_array)
            .ok_or_else(Error::contract)?;
        match files.as_slice() {
            [] => Ok(None),
            [file] => {
                let account: Account =
                    serde_json::from_value(file.clone()).map_err(|_| Error::contract())?;
                if account.kind != "antigravity" || account.name.is_empty() {
                    return Err(Error::contract());
                }
                Ok(Some(account))
            }
            _ => Err(Error::new(
                "unexpected_credentials",
                "组件账号目录不符合单账号要求",
            )),
        }
    }

    pub async fn registered_models(&self, name: &str) -> Result<Vec<Value>> {
        let value = self
            .request(
                reqwest::Method::GET,
                "/v0/management/auth-files/models",
                None,
                &[("name", name)],
            )
            .await?;
        value
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(Error::contract)
    }

    pub async fn definitions(&self) -> Result<Vec<Value>> {
        let value = self
            .request(
                reqwest::Method::GET,
                "/v0/management/model-definitions/antigravity",
                None,
                &[],
            )
            .await?;
        value
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(Error::contract)
    }

    pub async fn routed_models(&self) -> Result<Vec<String>> {
        // No Anthropic-Version, claude-cli UA or client_version: this endpoint
        // must select its ordinary OpenAI-shaped model-list envelope.
        let value = self
            .request(reqwest::Method::GET, "/v1/models", None, &[])
            .await?;
        let models = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(Error::contract)?;
        models
            .iter()
            .map(|m| {
                m.get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(Error::contract)
            })
            .collect()
    }
}

/// Bounded local JSON responses; never propagate native bodies or URLs.
pub(super) async fn bounded_json(mut response: reqwest::Response) -> Result<Value> {
    if !response.status().is_success() {
        return Err(Error::new(
            "component_contract",
            format!("组件接口返回 HTTP {}", response.status().as_u16()),
        ));
    }
    const LIMIT: usize = 1024 * 1024;
    if response.content_length().unwrap_or(0) > LIMIT as u64 {
        return Err(Error::contract());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::contract())? {
        if bytes.len().saturating_add(chunk.len()) > LIMIT {
            return Err(Error::contract());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::contract())
}
