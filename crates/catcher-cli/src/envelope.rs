// Envelopes: every message between the owner and agents, end-to-end encrypted.
//
// body = XChaCha20-Poly1305(K, nonce, aad = canonical({ctx, core}))
// wrap = XChaCha20-Poly1305(KEK_r, wrapNonce, K, aad = "catcher/v1/wrap|id|r"), KEK from one ephemeral X25519 + HKDF
// sig  = Ed25519(sender, canonical({ctx, core, wraps, ctHash}))
// Recipients are always the target, the owner and the sender.

use crate::bytes::{b64, unb64};
use crate::crypto::{
    box_public, derive, seal, sha256, sha256_parts, shared_secret, sign, unseal, verify,
};
use crate::identity::Identity;
use crate::json::{self, Obj, Value, canonical, is, strict_eq, to_js_string, truthy};

pub const ENVELOPE_TYPES: [&str; 7] = [
    "message",
    "reply",
    "ask",
    "confirm",
    "otp",
    "grant-request",
    "answer",
];
pub const OWNER_REQUEST_TYPES: [&str; 4] = ["ask", "confirm", "otp", "grant-request"];
pub const MAX_BODY_BYTES: usize = 64 * 1024;

pub struct SealInput<'a> {
    pub id: String,
    pub owner_id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub seq: f64,
    pub body: &'a Value,
    pub reference: Option<String>,
    pub scope: Option<String>,
    pub grant_id: Option<String>,
    pub expires_at: Option<f64>,
    pub created_at: f64,
    pub sender: &'a Identity,
    /// (id, boxPub) — must cover `to`, the owner and the sender
    pub recipients: Vec<(String, String)>,
}

fn body_aad(core: &Value) -> Result<Vec<u8>, String> {
    let o = Obj::new()
        .with("ctx", "catcher/v1/body")
        .with("core", core.clone());
    Ok(canonical(&Value::Obj(o))?.into_bytes())
}

fn signed_bytes(env: &Value) -> Result<Vec<u8>, String> {
    let mut o = Obj::new().with("ctx", "catcher/v1/envelope");
    for k in ["core", "wraps", "ctHash"] {
        if let Some(v) = env.get(k) {
            o.set(k, v.clone());
        }
    }
    Ok(canonical(&Value::Obj(o))?.into_bytes())
}

fn wrap_key(shared: &[u8; 32], eph_pub: &[u8], recipient_box: &[u8]) -> [u8; 32] {
    derive(
        shared,
        "catcher/v1/wrap",
        Some(&[eph_pub, recipient_box].concat()),
    )
}

fn key_commitment(key: &[u8]) -> String {
    b64(&sha256_parts(&[b"catcher/v1/key", key]))
}

fn wrap_aad(envelope_id: &str, recipient_id: &str) -> Vec<u8> {
    format!("catcher/v1/wrap|{envelope_id}|{recipient_id}").into_bytes()
}

/// [to, ownerId, from] without duplicates (JS `new Set` order). Values are kept as JSON for strict comparisons.
fn required_recipients(core: &Value) -> Vec<Option<&Value>> {
    let mut out: Vec<Option<&Value>> = Vec::new();
    for k in ["to", "ownerId", "from"] {
        let v = core.get(k);
        if !out.iter().any(|x| same_value_zero(*x, v)) {
            out.push(v);
        }
    }
    out
}

fn same_value_zero(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Num(x)), Some(Value::Num(y))) if x.is_nan() && y.is_nan() => true,
        _ => strict_eq(a, b),
    }
}

fn opt_str(v: &Option<String>) -> Value {
    v.as_deref().map(Value::from).unwrap_or(Value::Null)
}

pub fn seal_envelope(
    input: SealInput,
    random: &mut dyn FnMut(usize) -> Vec<u8>,
) -> Result<Value, String> {
    let plaintext = json::stringify(input.body).into_bytes();
    if plaintext.len() > MAX_BODY_BYTES {
        return Err(format!("message body is over {MAX_BODY_BYTES} bytes"));
    }
    let eph_secret: [u8; 32] = random(32)
        .try_into()
        .map_err(|_| "random source returned the wrong length")?;
    let eph_pub = box_public(&eph_secret);
    let nonce = random(24);
    let key = random(32);
    let core = Value::Obj(
        Obj::new()
            .with("v", 1.0)
            .with("id", &input.id)
            .with("ownerId", &input.owner_id)
            .with("from", &input.from)
            .with("to", &input.to)
            .with("type", &input.kind)
            .with("seq", input.seq)
            .with("createdAt", input.created_at)
            .with("ref", opt_str(&input.reference))
            .with("scope", opt_str(&input.scope))
            .with("grantId", opt_str(&input.grant_id))
            .with(
                "expiresAt",
                input.expires_at.map(Value::Num).unwrap_or(Value::Null),
            )
            .with("nonce", b64(&nonce))
            .with("ephPub", b64(&eph_pub))
            .with("keyHash", key_commitment(&key)),
    );
    let mut need: Vec<&str> = Vec::new();
    for id in [&input.to, &input.owner_id, &input.from] {
        if !need.contains(&id.as_str()) {
            need.push(id);
        }
    }
    let missing: Vec<&str> = need
        .iter()
        .copied()
        .filter(|id| !input.recipients.iter().any(|(rid, _)| rid == id))
        .collect();
    if !missing.is_empty() {
        return Err(format!("no box key for recipient {}", missing.join(", ")));
    }
    let mut wraps = Vec::new();
    for rid in need {
        // later duplicates win, like `new Map(recipients)`
        let box_pub = &input
            .recipients
            .iter()
            .rev()
            .find(|(id, _)| id == rid)
            .map(|(_, b)| b.clone())
            .unwrap_or_default();
        let recipient_box = unb64(box_pub)?;
        let kek = wrap_key(
            &shared_secret(&eph_secret, &recipient_box)?,
            &eph_pub,
            &recipient_box,
        );
        let wrap_nonce = random(24);
        let wrapped = seal(&kek, &wrap_nonce, &key, &wrap_aad(&input.id, rid))?;
        wraps.push(Value::Obj(
            Obj::new()
                .with("to", rid)
                .with("nonce", b64(&wrap_nonce))
                .with("key", b64(&wrapped)),
        ));
    }
    let ct = seal(&key, &nonce, &plaintext, &body_aad(&core)?)?;
    let ct_hash = b64(&sha256(&ct));
    let mut env = Obj::new()
        .with("core", core)
        .with("wraps", Value::Arr(wraps))
        .with("ctHash", ct_hash);
    let sig = sign(
        &signed_bytes(&Value::Obj(env.clone()))?,
        &input.sender.sign_secret,
    );
    env.set("ct", b64(&ct).into());
    env.set("sig", b64(&sig).into());
    Ok(Value::Obj(env))
}

/// Structural rules plus the sender signature (grant policy is in policy.rs).
pub fn verify_envelope(env: &Value, sender_sign_pub: &str) -> Result<(), String> {
    let core = match env {
        Value::Obj(_) | Value::Arr(_) if truthy(env.get("core")) => env.get("core"),
        _ => return Err("envelope missing".into()),
    };
    let c = |k: &str| core.and_then(|c| c.get(k));
    let core_v = core.unwrap_or(&Value::Null);
    if !strict_eq(c("v"), Some(&Value::Num(1.0))) {
        return Err("unsupported envelope version".into());
    }
    let kind = c("type");
    if !ENVELOPE_TYPES.iter().any(|t| is(kind, t)) {
        return Err(format!("unknown envelope type {}", to_js_string(kind)));
    }
    let kind = kind.and_then(Value::as_str).unwrap_or_default();
    let seq_ok = matches!(c("seq"), Some(Value::Num(n)) if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 && *n >= 1.0);
    if !seq_ok {
        return Err("envelope seq must be a positive integer".into());
    }
    if (kind == "reply" || kind == "answer") && !truthy(c("ref")) {
        return Err(format!("{kind} needs ref"));
    }
    if kind == "answer" && !strict_eq(c("from"), c("ownerId")) {
        return Err("only the owner can answer".into());
    }
    if OWNER_REQUEST_TYPES.contains(&kind) && !strict_eq(c("to"), c("ownerId")) {
        return Err(format!("{kind} goes to the owner only"));
    }
    let agent_to_agent = !strict_eq(c("from"), c("ownerId")) && !strict_eq(c("to"), c("ownerId"));
    if agent_to_agent && kind == "message" && (!truthy(c("scope")) || !truthy(c("grantId"))) {
        return Err("agent messages need a scope and a grant".into());
    }
    if agent_to_agent && kind == "reply" && !truthy(c("grantId")) {
        return Err("agent replies need the grant of the message".into());
    }
    if !matches!(c("keyHash"), Some(Value::Str(_))) {
        return Err("envelope has no key commitment".into());
    }
    if strict_eq(c("from"), c("to")) {
        return Err("cannot send to yourself".into());
    }
    let wraps = env
        .get("wraps")
        .and_then(Value::as_arr)
        .ok_or("env.wraps.map is not a function")?;
    let ids: Vec<Option<&Value>> = wraps.iter().map(|w| w.get("to")).collect();
    for (i, a) in ids.iter().enumerate() {
        if ids[..i].iter().any(|b| same_value_zero(*a, *b)) {
            return Err("duplicate recipient".into());
        }
    }
    let need = required_recipients(core_v);
    for n in &need {
        if !ids.iter().any(|id| same_value_zero(*id, *n)) {
            return Err(format!("envelope is not readable by {}", to_js_string(*n)));
        }
    }
    if ids.len() != need.len() {
        return Err("envelope has extra recipients".into());
    }
    let ct = unb64(env.str("ct").ok_or("bad base64url")?)?;
    if !is(env.get("ctHash"), &b64(&sha256(&ct))) {
        return Err("ciphertext hash mismatch".into());
    }
    let sig = unb64(env.str("sig").ok_or("bad base64url")?)?;
    let bytes = signed_bytes(env)?;
    let key = unb64(sender_sign_pub)?;
    if !verify(&sig, &bytes, &key) {
        return Err("envelope signature is invalid".into());
    }
    Ok(())
}

/// Decrypt for one recipient. Call verify_envelope first with the sender's verified key.
pub fn open_envelope(env: &Value, my_id: &str, me: &Identity) -> Result<Value, String> {
    let wrap = env
        .get("wraps")
        .and_then(Value::as_arr)
        .and_then(|w| w.iter().find(|w| is(w.get("to"), my_id)))
        .ok_or("this envelope is not addressed to you")?;
    let core = env.get("core").ok_or("envelope missing")?;
    let field =
        |v: &Value, k: &str| -> Result<Vec<u8>, String> { unb64(v.str(k).ok_or("bad base64url")?) };
    let eph_pub = field(core, "ephPub")?;
    let kek = wrap_key(
        &shared_secret(&me.box_secret, &eph_pub)?,
        &eph_pub,
        &me.box_pub,
    );
    let id = core.get("id");
    let key = unseal(
        &kek,
        &field(wrap, "nonce")?,
        &field(wrap, "key")?,
        &wrap_aad(&to_js_string(id), my_id),
    )?;
    if !is(core.get("keyHash"), &key_commitment(&key)) {
        return Err("body key does not match the commitment".into());
    }
    let plaintext = unseal(
        &key,
        &field(core, "nonce")?,
        &field(env, "ct")?,
        &body_aad(core)?,
    )?;
    let text = String::from_utf8(plaintext)
        .map_err(|_| "The encoded data was not valid for encoding utf-8".to_string())?;
    // TextDecoder drops a leading BOM
    json::parse(text.strip_prefix('\u{FEFF}').unwrap_or(&text))
}
