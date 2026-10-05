//! Bounded metadata at external HTTP owner boundaries. Never format a request,
//! URL, response body or reqwest error into a diagnostic.
use std::time::Instant;

pub(crate) fn error_category(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connection"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else {
        "request"
    }
}

pub(crate) fn safe_request_id(value: Option<&str>) -> Option<&str> {
    value.filter(|value| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    })
}

pub(crate) fn response_request_id(response: &reqwest::Response) -> Option<String> {
    safe_request_id(
        response
            .headers()
            .get("x-request-id")
            .or_else(|| response.headers().get("request-id"))
            .and_then(|value| value.to_str().ok()),
    )
    .map(str::to_owned)
}

fn route(path: &str) -> String {
    // Only known route vocabulary survives; every dynamic component is redacted.
    // Query values, escaped segments and arbitrary caller input never survive.
    if !path.starts_with('/') || path.starts_with("//") {
        return "/:redacted".into();
    }
    path.split(['?', '#'])
        .next()
        .unwrap_or("")
        .split('/')
        .take(12)
        .map(|part| match part {
            "" | "api" | "v1" | "me" | "network" | "agent-network" | "identity" | "state"
            | "rotate" | "current" | "certificate" | "challenge" | "jwks" | "devices" | "self"
            | "catalog" | "agents" | "networks" | "callable-agents" | "mounts" | "mutations"
            | "join" | "leave" | "ws" | "notifications" | "read" | "read-all" | "spaces"
            | "issues" | "goals" | "skills" | "tools" | "comments" | "attachments" | "download"
            | "upload" | "profile" | "avatar" | "events" | "auth" | "start" | "poll" | "ack"
            | "upsert" => part,
            _ => ":redacted",
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) struct RequestDiagnostic {
    service: &'static str,
    method: reqwest::Method,
    route: String,
    started: Instant,
}
impl RequestDiagnostic {
    pub(crate) fn new(service: &'static str, method: &reqwest::Method, path: &str) -> Self {
        Self {
            service,
            method: method.clone(),
            route: route(path),
            started: Instant::now(),
        }
    }
    pub(crate) async fn send(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, reqwest::Error> {
        request
            .send()
            .await
            .inspect_err(|error| self.failure("send", error_category(error), None, None))
    }
    pub(crate) fn failure(
        &self,
        phase: &'static str,
        category: &'static str,
        status: Option<u16>,
        request_id: Option<&str>,
    ) {
        let message = format!(
            "[network] service={} method={} route={} phase={} category={} status={} durationMs={}",
            self.service,
            self.method,
            self.route,
            phase,
            category,
            status
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".into()),
            self.started.elapsed().as_millis()
        );
        if let Some(request_id) = safe_request_id(request_id) {
            crate::ulog_warn!(message; request_id = request_id);
        } else {
            crate::ulog_warn!("{}", message);
        }
    }
}

// Loopback-only HTTP fixtures exercise bounded streaming readers without real
// credentials, TLS identities, production services or user files.
#[cfg(test)]
pub(crate) async fn test_response(
    status: u16,
    bytes: Vec<u8>,
    truncated: bool,
) -> (reqwest::Response, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        socket
            .set_write_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut request = [0u8; 2048];
        let received = socket.read(&mut request).unwrap();
        assert!(received > 0, "fixture requires an HTTP request");
        write!(socket, "HTTP/1.1 {status} Failure\r\nContent-Length: {}\r\nRetry-After: 45\r\nConnection: close\r\n\r\n", bytes.len() + usize::from(truncated)).unwrap();
        // An over-limit reader may stop before consuming the whole fixture.
        let _ = socket.write_all(&bytes);
    });
    let response = crate::local_http::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap()
        .get(format!("http://{address}/fixture"))
        .send()
        .await
        .unwrap();
    (response, server)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_and_correlation_never_disclose_dynamic_input() {
        assert_eq!(
            route("/api/issues/private-id/comments?token=secret#secret"),
            "/api/issues/:redacted/comments"
        );
        assert_eq!(
            route("https://user:secret@example.test/private"),
            "/:redacted"
        );
        assert_eq!(route("//user:secret@host/path"), "/:redacted");
        assert_eq!(
            route("/v1/networks/%73ecret/mounts/token-value"),
            "/v1/networks/:redacted/mounts/:redacted"
        );
        assert_eq!(
            safe_request_id(Some("request-123_abc")),
            Some("request-123_abc")
        );
        for value in ["", "Bearer token", "secret?url", "line\nnext"] {
            assert!(safe_request_id(Some(value)).is_none());
        }
        assert!(safe_request_id(Some(&"x".repeat(129))).is_none());
    }
    #[tokio::test]
    async fn reqwest_projection_drops_secret_url() {
        let error = crate::local_http::builder()
            .build()
            .unwrap()
            .get("http://[::1")
            .send()
            .await
            .unwrap_err();
        assert_eq!(error_category(&error), "request");
    }
}
