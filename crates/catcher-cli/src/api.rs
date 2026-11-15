// Signed HTTP calls to the catcher relay.

use std::time::Duration;

use crate::auth::{AUTH_HEADER, now_ms, sign_request};
use crate::error::Error;
use crate::json::{self, Value, nullish, to_js_string, utf16_prefix};

pub struct Api {
    pub server: String,
    caller_id: Option<String>,
    sign_secret: Option<[u8; 32]>,
    agent: ureq::Agent,
}

impl Api {
    pub fn new(server: &str, caller: Option<(&str, [u8; 32])>) -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            // like Node's fetch: no proxy from the environment
            .proxy(None)
            // undici's defaults: 10s to connect, 300s for headers and for the body
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(300)))
            .timeout_recv_body(Some(Duration::from_secs(300)))
            .build();
        Api {
            server: server.trim_end_matches('/').to_string(),
            caller_id: caller.map(|c| c.0.to_string()),
            sign_secret: caller.map(|c| c.1),
            agent: ureq::Agent::new_with_config(config),
        }
    }

    pub fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        auth: bool,
    ) -> Result<Value, Error> {
        let raw = body
            .map(|b| json::stringify(b).into_bytes())
            .unwrap_or_default();
        let mut auth_header = None;
        if auth {
            let (Some(id), Some(secret)) = (&self.caller_id, &self.sign_secret) else {
                return Err(Error::Api {
                    status: 0,
                    code: "no_identity".into(),
                    message: "not registered yet".into(),
                });
            };
            auth_header = Some(sign_request(id, secret, method, path, &raw, now_ms()));
        }
        let url = format!("{}{}", self.server, path);
        let network = |_| Error::Api {
            status: 0,
            code: "network".into(),
            message: format!("cannot reach {}: fetch failed", self.server),
        };
        let result = if method == "POST" {
            let mut req = self.agent.post(&url).header("accept", "application/json");
            if body.is_some() {
                req = req.header("content-type", "application/json");
            }
            if let Some(h) = &auth_header {
                req = req.header(AUTH_HEADER, h);
            }
            req.send(&raw[..])
        } else {
            let mut req = self.agent.get(&url).header("accept", "application/json");
            if let Some(h) = &auth_header {
                req = req.header(AUTH_HEADER, h);
            }
            req.call()
        };
        let mut res = result.map_err(network)?;
        let status = res.status();
        let bytes = res
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_vec()
            .map_err(|e| Error::plain(format!("terminated: {e}")))?;
        let text = String::from_utf8_lossy(&bytes);
        let data = if text.is_empty() {
            Value::Null
        } else {
            json::parse(&text).unwrap_or(Value::Null)
        };
        if !status.is_success() {
            let err = data.get("error");
            let field = |k: &str| err.and_then(|e| e.get(k)).filter(|v| !nullish(Some(v)));
            let code = match field("code") {
                Some(v) => to_js_string(Some(v)),
                None => format!("http_{}", status.as_u16()),
            };
            let message = match field("message") {
                Some(v) => to_js_string(Some(v)),
                None => {
                    let head = utf16_prefix(&text, 200).0;
                    if head.is_empty() {
                        status.canonical_reason().unwrap_or("").to_string()
                    } else {
                        head.to_string()
                    }
                }
            };
            return Err(Error::Api {
                status: status.as_u16(),
                code,
                message,
            });
        }
        Ok(data)
    }
}
