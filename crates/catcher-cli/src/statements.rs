// Signed statements: the owner's decisions (and the agent's register proof), verified locally by every agent.

use crate::bytes::{b64, unb64};
use crate::crypto::{sign, verify};
use crate::identity::Identity;
use crate::identity::owner_id_for;
use crate::json::{Obj, Value, canonical, is, strict_eq, to_js_string};

fn statement_bytes(payload: Option<&Value>) -> Result<Vec<u8>, String> {
    let mut o = Obj::new().with("ctx", "catcher/v1/statement");
    if let Some(p) = payload {
        o.set("payload", p.clone());
    }
    Ok(canonical(&Value::Obj(o))?.into_bytes())
}

pub fn sign_statement(payload: Value, id: &Identity) -> Result<Value, String> {
    let sig = sign(&statement_bytes(Some(&payload))?, &id.sign_secret);
    Ok(Value::Obj(
        Obj::new()
            .with("payload", payload)
            .with("signer", b64(&id.sign_pub))
            .with("sig", b64(&sig)),
    ))
}

/// Checks kind, signer and signature. Returns the payload.
pub fn verify_statement<'a>(
    statement: &'a Value,
    kind: &str,
    expected_signer: &str,
) -> Result<&'a Value, String> {
    if !matches!(statement, Value::Obj(_) | Value::Arr(_)) {
        return Err("statement missing".into());
    }
    let payload = statement.get("payload");
    if !is(payload.and_then(|p| p.get("kind")), kind) {
        return Err(format!("expected a {kind} statement"));
    }
    if !is(statement.get("signer"), expected_signer) {
        return Err(format!("{kind} is not signed by the expected key"));
    }
    let ok = (|| -> Result<bool, String> {
        let sig = unb64(statement.str("sig").ok_or("bad base64url")?)?;
        let bytes = statement_bytes(payload)?;
        let signer = unb64(expected_signer)?;
        Ok(verify(&sig, &bytes, &signer))
    })()
    .unwrap_or(false);
    if !ok {
        return Err(format!("{kind} signature is invalid"));
    }
    payload.ok_or_else(|| format!("{kind} signature is invalid"))
}

#[derive(Clone, Debug, PartialEq)]
pub struct OwnerKeys {
    pub sign_pub: String,
    pub box_pub: String,
    pub seq: f64,
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::Str(s)) => s.clone(),
        other => to_js_string(other),
    }
}

/// Walk the owner key chain from a pinned key to the newest one. Links before the pinned key are ignored.
pub fn resolve_owner_keys(
    chain: &Value,
    owner_id: &str,
    pinned_sign: &str,
    pinned_box: &str,
) -> Result<OwnerKeys, String> {
    let links = chain.as_arr().ok_or("owner key chain is not iterable")?;
    let mut current: Option<OwnerKeys> = None;
    for link in links {
        let p = link.get("payload");
        let p_get = |k: &str| p.and_then(|p| p.get(k));
        if !is(p_get("kind"), "owner-key") || !is(p_get("ownerId"), owner_id) {
            return Err("owner key chain is for another owner".into());
        }
        let Some(cur) = &current else {
            if !is(p_get("signPub"), pinned_sign) {
                continue;
            }
            // the pinned link itself was checked out of band (pairing fingerprint)
            if !is(p_get("boxPub"), pinned_box) {
                return Err("owner key chain does not match the pinned box key".into());
            }
            current = Some(OwnerKeys {
                sign_pub: text(p_get("signPub")),
                box_pub: text(p_get("boxPub")),
                seq: crate::json::to_number(p_get("seq")),
            });
            continue;
        };
        if !strict_eq(p_get("seq"), Some(&Value::Num(cur.seq + 1.0))) {
            return Err("owner key chain skips a link".into());
        }
        verify_statement(link, "owner-key", &cur.sign_pub)?;
        current = Some(OwnerKeys {
            sign_pub: text(p_get("signPub")),
            box_pub: text(p_get("boxPub")),
            seq: crate::json::to_number(p_get("seq")),
        });
    }
    current.ok_or_else(|| "pinned owner key is not in the owner key chain".to_string())
}

/// Full chain check from genesis.
pub fn verify_owner_chain(chain: &Value, owner_id: &str) -> Result<OwnerKeys, String> {
    let first = chain
        .as_arr()
        .and_then(|a| a.first())
        .ok_or("owner key chain is empty")?;
    let signer = first.str("signer").unwrap_or_default();
    let genesis = verify_statement(first, "owner-key", signer)?;
    if genesis.num("seq") != Some(0.0) || !is(genesis.get("signPub"), signer) {
        return Err("owner key genesis must be self-signed".into());
    }
    if owner_id_for(signer) != owner_id {
        return Err("owner id does not match the genesis key".into());
    }
    resolve_owner_keys(
        chain,
        owner_id,
        signer,
        genesis.str("boxPub").unwrap_or_default(),
    )
}
