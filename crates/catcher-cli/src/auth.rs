// Request authentication: every API call is signed by the caller's Ed25519 key.
// Header: x-catcher-auth: <callerId>.<timestampMs>.<signature b64url>

use crate::bytes::b64;
use crate::crypto::{sha256, sign};
use crate::json::{Obj, Value, canonical};

pub const AUTH_HEADER: &str = "x-catcher-auth";

/// The bytes a request signature covers.
pub fn auth_bytes(method: &str, path: &str, ts: f64, body: &[u8]) -> Vec<u8> {
    let o = Obj::new()
        .with("ctx", "catcher/v1/request")
        .with("method", method.to_uppercase())
        .with("path", path)
        .with("ts", ts)
        .with("bodyHash", b64(&sha256(body)));
    // only safe-integer timestamps reach here, so canonical cannot fail
    canonical(&Value::Obj(o)).unwrap_or_default().into_bytes()
}

pub fn sign_request(
    caller_id: &str,
    sign_secret: &[u8; 32],
    method: &str,
    path: &str,
    body: &[u8],
    now: f64,
) -> String {
    let sig = sign(&auth_bytes(method, path, now, body), sign_secret);
    format!(
        "{caller_id}.{}.{}",
        crate::json::number_to_string(now),
        b64(&sig)
    )
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}
