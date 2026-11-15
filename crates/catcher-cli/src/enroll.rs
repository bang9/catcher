// Agent-first registration, byte-compatible with packages/protocol/src/enroll.ts (see the comment there).
//
//   code    = L(lookup, 5) S(secret, 5) T(tag, 5) check(1), Crockford, shown as XXXX-XXXX-XXXX-XXXX
//   T       = b32(SHA-256(canonical({ctx: "catcher/v1/enroll-tag", lookup, secret, signPub, boxPub}))[0..4])[0..5]
//   check   = b32(SHA-256("catcher/v1/enroll-check" + L + S + T)[0..1])[0..1]
//   agentId = "a_" + lower(b32(SHA-256("catcher/v1/agent" ‖ signPub)[0..10]))
//
// Only L reaches the relay. A claim is accepted only when it is sealed to this agent's box key and carries its S.

use crate::bytes::{b32, b64, groups, unb64};
use crate::crypto::{box_public, derive, seal, sha256, sha256_parts, shared_secret, unseal};
use crate::identity::Identity;
use crate::json::{Obj, Value, canonical, is};
use crate::statements::{sign_statement, verify_statement};

/// How long a registration code stays claimable (the relay decides; this is the local estimate before it answers).
pub const ENROLL_TTL_MS: f64 = 10.0 * 60.0 * 1000.0;
pub const MAX_DEVICE: usize = 80;
pub const MAX_PROVIDER: usize = 40;

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PART: usize = 5;
const CODE_LENGTH: usize = 3 * PART + 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnrollCode {
    pub lookup: String,
    pub secret: String,
    pub tag: String,
    pub check: String,
    /// XXXX-XXXX-XXXX-XXXX
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedCode {
    pub lookup: String,
    pub secret: String,
    pub tag: String,
}

pub fn agent_id_for(sign_pub: &str) -> String {
    let digest = sha256_parts(&[b"catcher/v1/agent", sign_pub.as_bytes()]);
    format!("a_{}", b32(&digest[..10]).to_lowercase())
}

/// Ten random bytes → L (bytes 0..4) and S (bytes 5..9), one character per byte.
pub fn enroll_parts(random10: &[u8]) -> Result<(String, String), String> {
    if random10.len() != 10 {
        return Err("enroll parts need 10 random bytes".into());
    }
    let ch = |b: &u8| CROCKFORD[usize::from(b & 31)] as char;
    Ok((
        random10[..PART].iter().map(ch).collect(),
        random10[PART..].iter().map(ch).collect(),
    ))
}

pub fn enroll_tag(lookup: &str, secret: &str, sign_pub: &str, box_pub: &str) -> String {
    let o = Obj::new()
        .with("ctx", "catcher/v1/enroll-tag")
        .with("lookup", lookup)
        .with("secret", secret)
        .with("signPub", sign_pub)
        .with("boxPub", box_pub);
    // only strings: canonical cannot fail
    let bytes = canonical(&Value::Obj(o)).unwrap_or_default().into_bytes();
    b32(&sha256(&bytes)[..4])[..PART].to_string()
}

pub fn enroll_check(lookup: &str, secret: &str, tag: &str) -> String {
    let digest = sha256(format!("catcher/v1/enroll-check{lookup}{secret}{tag}").as_bytes());
    b32(&digest[..1])[..1].to_string()
}

pub fn enroll_code(lookup: &str, secret: &str, sign_pub: &str, box_pub: &str) -> EnrollCode {
    let tag = enroll_tag(lookup, secret, sign_pub, box_pub);
    let check = enroll_check(lookup, secret, &tag);
    let code = groups(&format!("{lookup}{secret}{tag}{check}"), 4);
    EnrollCode {
        lookup: lookup.into(),
        secret: secret.into(),
        tag,
        check,
        code,
    }
}

/// `<site>/r#<code>`: the fragment never reaches any server.
pub fn enroll_link(site: &str, code: &str) -> String {
    format!("{}/r#{code}", site.trim_end_matches('/'))
}

/// Same normalisation as the TS `normalizeB32`: upper case, no spaces or dashes, O → 0, I/L → 1.
fn normalize(text: &str) -> String {
    text.chars()
        .flat_map(char::to_uppercase)
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect()
}

/// A typed or pasted code (or a link ending in #code). Errors are (problem, message), problem being
/// bad_length / bad_char / bad_check.
pub fn parse_enroll_code(text: &str) -> Result<ParsedCode, (&'static str, String)> {
    let raw = match text.rfind('#') {
        Some(i) => &text[i + 1..],
        None => text,
    };
    let clean = normalize(raw);
    if clean.chars().count() != CODE_LENGTH {
        return Err((
            "bad_length",
            format!("a registration code has {CODE_LENGTH} characters"),
        ));
    }
    if !clean.bytes().all(|b| CROCKFORD.contains(&b)) {
        return Err((
            "bad_char",
            "the code has a character that is not used in codes".into(),
        ));
    }
    let lookup = &clean[..PART];
    let secret = &clean[PART..2 * PART];
    let tag = &clean[2 * PART..3 * PART];
    if enroll_check(lookup, secret, tag) != clean[3 * PART..] {
        return Err(("bad_check", "the code has a typo".into()));
    }
    Ok(ParsedCode {
        lookup: lookup.into(),
        secret: secret.into(),
        tag: tag.into(),
    })
}

/// Length-leaking, content-constant-time byte comparison.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub struct EnrollInput<'a> {
    pub lookup: &'a str,
    pub name: &'a str,
    pub device: &'a str,
    pub provider: &'a str,
    pub issued_at: f64,
}

/// The agent's self-signed request to be registered; field order matches the TS `signEnroll`.
pub fn sign_enroll(input: &EnrollInput, agent: &Identity) -> Result<Value, String> {
    let payload = Obj::new()
        .with("kind", "enroll")
        .with("lookup", input.lookup)
        .with("name", input.name)
        .with("signPub", b64(&agent.sign_pub))
        .with("boxPub", b64(&agent.box_pub))
        .with("device", input.device)
        .with("provider", input.provider)
        .with("issuedAt", input.issued_at);
    sign_statement(Value::Obj(payload), agent)
}

/// The bytes a claim's AEAD covers: every field except `sealed`.
pub fn claim_aad(payload: &Value) -> Result<Vec<u8>, String> {
    let mut bind = payload.as_obj().cloned().ok_or("claim is malformed")?;
    bind.0.retain(|(k, _)| k != "sealed");
    let o = Obj::new()
        .with("ctx", "catcher/v1/claim")
        .with("claim", Value::Obj(bind));
    Ok(canonical(&Value::Obj(o))?.into_bytes())
}

/// KEK = HKDF-SHA256(X25519(eph, agentBoxPub), salt = ephPub ‖ agentBoxPub, info = "catcher/v1/claim-key").
pub fn claim_key(shared: &[u8], eph_pub: &[u8], agent_box_pub: &[u8]) -> [u8; 32] {
    let salt = [eph_pub, agent_box_pub].concat();
    derive(shared, "catcher/v1/claim-key", Some(&salt))
}

pub struct ClaimInput<'a> {
    pub owner: &'a Identity,
    pub owner_id: &'a str,
    pub lookup: &'a str,
    pub secret: &'a str,
    pub agent_id: &'a str,
    pub agent_sign_pub: &'a str,
    pub agent_box_pub: &'a str,
    pub issued_at: f64,
}

/// Owner side (the app does this in TS; here for vectors and tests). Draws the eph secret (32) then the nonce (24).
pub fn seal_claim(
    input: &ClaimInput,
    random: &mut dyn FnMut(usize) -> Vec<u8>,
) -> Result<Value, String> {
    let eph: [u8; 32] = random(32)
        .try_into()
        .map_err(|_| "random gave the wrong length")?;
    let eph_pub = box_public(&eph);
    let nonce = random(24);
    let agent_box = unb64(input.agent_box_pub)?;
    let mut payload = Obj::new()
        .with("kind", "claim")
        .with("ownerId", input.owner_id)
        .with("ownerSignPub", b64(&input.owner.sign_pub))
        .with("ownerBoxPub", b64(&input.owner.box_pub))
        .with("lookup", input.lookup)
        .with("agentId", input.agent_id)
        .with("agentSignPub", input.agent_sign_pub)
        .with("agentBoxPub", input.agent_box_pub)
        .with("ephPub", b64(&eph_pub))
        .with("nonce", b64(&nonce))
        .with("issuedAt", input.issued_at);
    let kek = claim_key(&shared_secret(&eph, &agent_box)?, &eph_pub, &agent_box);
    let aad = claim_aad(&Value::Obj(payload.clone()))?;
    let sealed = seal(&kek, &nonce, input.secret.as_bytes(), &aad)?;
    payload.set("sealed", Value::Str(b64(&sealed)));
    sign_statement(Value::Obj(payload), input.owner)
}

/// What the agent learns from a verified claim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimedBy {
    pub owner_id: String,
    pub owner_sign_pub: String,
    pub owner_box_pub: String,
}

/// Agent steps 1–4: signed by the key it names, for this lookup and these exact agent keys, and it carries this
/// agent's secret. Any error means: forget the registration (one guess only).
pub fn open_claim(
    claim: &Value,
    agent_id: &str,
    lookup: &str,
    secret: &str,
    me: &Identity,
) -> Result<ClaimedBy, String> {
    let owner_sign_pub = claim
        .get("payload")
        .and_then(|p| p.str("ownerSignPub"))
        .ok_or("claim names no owner key")?;
    let p = verify_statement(claim, "claim", owner_sign_pub)?;
    if !is(p.get("lookup"), lookup) || !is(p.get("agentId"), agent_id) {
        return Err("claim is for another registration".into());
    }
    if !is(p.get("agentSignPub"), &b64(&me.sign_pub))
        || !is(p.get("agentBoxPub"), &b64(&me.box_pub))
    {
        return Err("claim is for other agent keys".into());
    }
    let (Some(owner_id), Some(owner_box_pub)) = (p.str("ownerId"), p.str("ownerBoxPub")) else {
        return Err("claim is malformed".into());
    };
    let field =
        |k: &str| -> Result<Vec<u8>, String> { unb64(p.str(k).ok_or("claim is malformed")?) };
    let eph_pub = field("ephPub")?;
    let kek = claim_key(
        &shared_secret(&me.box_secret, &eph_pub)?,
        &eph_pub,
        &me.box_pub,
    );
    let plain = unseal(&kek, &field("nonce")?, &field("sealed")?, &claim_aad(p)?)
        .map_err(|_| "claim was not sealed to this agent".to_string())?;
    if !ct_eq(&plain, secret.as_bytes()) {
        return Err("claim does not carry this registration code".into());
    }
    Ok(ClaimedBy {
        owner_id: owner_id.into(),
        owner_sign_pub: owner_sign_pub.into(),
        owner_box_pub: owner_box_pub.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ct_eq_compares_content_and_length() {
        assert!(ct_eq(b"ABCDE", b"ABCDE"));
        assert!(!ct_eq(b"ABCDE", b"ABCDF"));
        assert!(!ct_eq(b"ABCDE", b"ABCD"));
    }

    #[test]
    fn parse_rejects_without_panicking_on_multibyte_input() {
        assert_eq!(
            parse_enroll_code("ü".repeat(16).as_str()).unwrap_err().0,
            "bad_char"
        );
        assert_eq!(parse_enroll_code("").unwrap_err().0, "bad_length");
    }
}
