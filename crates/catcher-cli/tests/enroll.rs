// Agent-first registration against the shared frozen vectors (packages/protocol/test/vectors.json), which the
// TypeScript tests read too.

use std::path::PathBuf;

use catcher::bytes::b64;
use catcher::crypto::{box_public, shared_secret};
use catcher::enroll::{
    ClaimInput, EnrollInput, agent_id_for, claim_aad, claim_key, enroll_code, enroll_parts,
    enroll_tag, open_claim, parse_enroll_code, seal_claim, sign_enroll,
};
use catcher::identity::{Identity, identity_from_seed};
use catcher::json::{self, Value, canonical};
use catcher::statements::{resolve_owner_keys, verify_statement};

fn vectors() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/test/vectors.json");
    json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.str(k).unwrap_or_else(|| panic!("missing {k}"))
}

fn fill(v: &Value) -> Identity {
    identity_from_seed(&[v.num("seedFill").unwrap() as u8; 32]).unwrap()
}

fn unhex(h: &str) -> Vec<u8> {
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
        .collect()
}

fn arr(v: &Value, k: &str) -> Vec<Value> {
    v.get(k).and_then(Value::as_arr).cloned().unwrap()
}

/// Fixed random stream: hands out the given chunks in order and checks the requested lengths.
fn stream(parts: Vec<Vec<u8>>) -> impl FnMut(usize) -> Vec<u8> {
    let mut parts = parts.into_iter();
    move |len| {
        let next = parts.next().expect("random stream exhausted");
        assert_eq!(next.len(), len, "random stream order");
        next
    }
}

#[test]
fn identities_and_agent_ids() {
    let v = vectors();
    let ids = v.get("identities").unwrap().as_obj().unwrap();
    for (_, who) in &ids.0 {
        let id = fill(who);
        assert_eq!(b64(&id.sign_pub), s(who, "signPub"));
        assert_eq!(b64(&id.box_pub), s(who, "boxPub"));
    }
    for a in arr(&v, "agentIds") {
        assert_eq!(agent_id_for(s(&a, "signPub")), s(&a, "agentId"));
    }
}

#[test]
fn codes_from_fixed_random_bytes() {
    let v = vectors();
    for c in arr(&v, "codes") {
        let (lookup, secret) = enroll_parts(&unhex(s(&c, "random"))).unwrap();
        let code = enroll_code(&lookup, &secret, s(&c, "signPub"), s(&c, "boxPub"));
        assert_eq!(code.lookup, s(&c, "lookup"));
        assert_eq!(code.secret, s(&c, "secret"));
        assert_eq!(code.tag, s(&c, "tag"));
        assert_eq!(code.check, s(&c, "check"));
        assert_eq!(code.code, s(&c, "code"));
    }
}

#[test]
fn tag_changes_with_every_input() {
    let v = vectors();
    let t = v.get("tagVariants").unwrap();
    let b = t.get("base").unwrap();
    let tag = |o: &dyn Fn(&str) -> String| {
        enroll_tag(&o("lookup"), &o("secret"), &o("signPub"), &o("boxPub"))
    };
    assert_eq!(tag(&|k| s(b, k).to_string()), s(b, "tag"));
    for variant in arr(t, "variants") {
        let field = s(&variant, "field").to_string();
        let value = s(&variant, "value").to_string();
        let got = tag(&|k| {
            if k == field {
                value.clone()
            } else {
                s(b, k).to_string()
            }
        });
        assert_eq!(got, s(&variant, "tag"));
        assert_ne!(got, s(b, "tag"), "{field}");
    }
}

#[test]
fn parsing() {
    let v = vectors();
    for p in arr(&v, "parse") {
        let input = s(&p, "input");
        match (p.get("ok"), parse_enroll_code(input)) {
            (Some(ok), Ok(parsed)) => {
                assert_eq!(parsed.lookup, s(ok, "lookup"), "{input}");
                assert_eq!(parsed.secret, s(ok, "secret"), "{input}");
                assert_eq!(parsed.tag, s(ok, "tag"), "{input}");
            }
            (None, Err((problem, _))) => assert_eq!(problem, s(&p, "error"), "{input}"),
            (_, other) => panic!("{input}: unexpected {other:?}"),
        }
    }
}

#[test]
fn enroll_statement_bytes_and_signature() {
    let v = vectors();
    let agent = fill(v.get("identities").unwrap().get("agent").unwrap());
    let e = v.get("enroll").unwrap();
    let statement = e.get("statement").unwrap();
    let p = statement.get("payload").unwrap();
    let ctx = json::Obj::new()
        .with("ctx", "catcher/v1/statement")
        .with("payload", p.clone());
    assert_eq!(canonical(&Value::Obj(ctx)).unwrap(), s(e, "canonical"));
    let signed = sign_enroll(
        &EnrollInput {
            lookup: s(p, "lookup"),
            name: s(p, "name"),
            device: s(p, "device"),
            provider: s(p, "provider"),
            issued_at: p.num("issuedAt").unwrap(),
        },
        &agent,
    )
    .unwrap();
    assert_eq!(&signed, statement);
    assert!(verify_statement(statement, "enroll", s(p, "signPub")).is_ok());
}

#[test]
fn claim_with_fixed_eph_and_nonce() {
    let v = vectors();
    let ids = v.get("identities").unwrap();
    let owner = fill(ids.get("owner").unwrap());
    let agent = fill(ids.get("agent").unwrap());
    let ctx = v.get("claimContext").unwrap();
    let c = v.get("claim").unwrap();
    let eph = unhex(s(c, "ephSecret"));
    let claim = seal_claim(
        &ClaimInput {
            owner: &owner,
            owner_id: s(ids.get("owner").unwrap(), "ownerId"),
            lookup: s(ctx, "lookup"),
            secret: s(ctx, "secret"),
            agent_id: s(ctx, "agentId"),
            agent_sign_pub: &b64(&agent.sign_pub),
            agent_box_pub: &b64(&agent.box_pub),
            issued_at: v.num("now").unwrap(),
        },
        &mut stream(vec![eph.clone(), unhex(s(c, "nonce"))]),
    )
    .unwrap();
    assert_eq!(&claim, c.get("statement").unwrap());
    let payload = claim.get("payload").unwrap();
    assert_eq!(
        String::from_utf8(claim_aad(payload).unwrap()).unwrap(),
        s(c, "aad")
    );
    let eph: [u8; 32] = eph.try_into().unwrap();
    let shared = shared_secret(&eph, &agent.box_pub).unwrap();
    assert_eq!(
        b64(&claim_key(&shared, &box_public(&eph), &agent.box_pub)),
        s(c, "kek")
    );
    let by = open_claim(
        c.get("statement").unwrap(),
        s(ctx, "agentId"),
        s(ctx, "lookup"),
        s(ctx, "secret"),
        &agent,
    )
    .unwrap();
    assert_eq!(by.owner_sign_pub, b64(&owner.sign_pub));
    assert_eq!(by.owner_id, s(ids.get("owner").unwrap(), "ownerId"));
}

#[test]
fn claim_negatives_are_all_refused() {
    let v = vectors();
    let agent = fill(v.get("identities").unwrap().get("agent").unwrap());
    let ctx = v.get("claimContext").unwrap();
    let open = |claim: &Value, secret: &str| {
        open_claim(claim, s(ctx, "agentId"), s(ctx, "lookup"), secret, &agent)
    };
    for n in arr(&v, "claimNegatives") {
        assert!(
            open(n.get("claim").unwrap(), s(ctx, "secret")).is_err(),
            "{}",
            s(&n, "name")
        );
    }
    let good = v.get("claim").unwrap().get("statement").unwrap();
    assert!(open(good, s(ctx, "secret")).is_ok());
    assert!(open(good, "ZZZZZ").is_err());
}

#[test]
fn rotation_walks_forward_from_the_claim_key() {
    let v = vectors();
    let r = v.get("rotation").unwrap();
    let pinned = r.get("pinned").unwrap();
    let current = r.get("current").unwrap();
    let keys = resolve_owner_keys(
        r.get("chain").unwrap(),
        s(r, "ownerId"),
        s(pinned, "signPub"),
        s(pinned, "boxPub"),
    )
    .unwrap();
    assert_eq!(keys.sign_pub, s(current, "signPub"));
    assert_eq!(keys.box_pub, s(current, "boxPub"));
    assert_eq!(keys.seq, current.num("seq").unwrap());
}
