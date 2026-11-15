// Frozen vectors and protocol rules, mirrored from packages/protocol/test/protocol.test.ts.

use catcher::bytes::b64;
use catcher::crypto::sha256;
use catcher::envelope::{SealInput, open_envelope, seal_envelope, verify_envelope};
use catcher::identity::{
    Identity, fingerprint, identity_from_seed, owner_id_for, public_keys, recovery_code,
    seed_from_recovery_code,
};
use catcher::json::{Obj, Value};
use catcher::policy::{build_trust, check_envelope};
use catcher::statements::{sign_statement, verify_owner_chain, verify_statement};

/// Same as the TS `det(tag)`: SHA-256(`tag/n`) blocks, counter advancing per 32-byte block.
fn det(tag: &str) -> impl FnMut(usize) -> Vec<u8> {
    let tag = tag.to_string();
    let mut n = 0;
    move |len| {
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            let h = sha256(format!("{tag}/{n}").as_bytes());
            n += 1;
            let take = (len - out.len()).min(32);
            out.extend_from_slice(&h[..take]);
        }
        out
    }
}

fn id(fill: u8) -> Identity {
    identity_from_seed(&[fill; 32]).unwrap()
}

const NOW: f64 = 1_700_000_000_000.0;

struct World {
    owner: Identity,
    a: Identity,
    b: Identity,
    owner_id: String,
}

fn world() -> World {
    let owner = id(1);
    let owner_id = owner_id_for(&b64(&owner.sign_pub));
    World {
        owner,
        a: id(2),
        b: id(3),
        owner_id,
    }
}

const A: &str = "a_1111111111111111";
const B: &str = "a_2222222222222222";

fn keys_obj(o: Obj, who: &Identity) -> Obj {
    let k = public_keys(who);
    o.with("signPub", k.sign_pub).with("boxPub", k.box_pub)
}

fn genesis(w: &World) -> Value {
    let p = keys_obj(
        Obj::new()
            .with("kind", "owner-key")
            .with("ownerId", &w.owner_id)
            .with("seq", 0.0),
        &w.owner,
    )
    .with("issuedAt", NOW);
    sign_statement(Value::Obj(p), &w.owner).unwrap()
}

fn cert(w: &World, agent_id: &str, who: &Identity, name: &str, floor: f64) -> Value {
    let p = keys_obj(
        Obj::new()
            .with("kind", "cert")
            .with("ownerId", &w.owner_id)
            .with("agentId", agent_id)
            .with("name", name),
        who,
    )
    .with("device", "test")
    .with("provider", "test")
    .with("issuedAt", NOW)
    .with("expiresAt", NOW + 86_400_000.0)
    .with("revocationFloor", floor);
    sign_statement(Value::Obj(p), &w.owner).unwrap()
}

fn grant(w: &World, require_approval: bool) -> Value {
    let p = Obj::new()
        .with("kind", "grant")
        .with("ownerId", &w.owner_id)
        .with("grantId", "g_1111111111111111")
        .with("from", A)
        .with("to", B)
        .with("scopes", Value::Arr(vec!["message".into()]))
        .with("requireApproval", require_approval)
        .with("issuedAt", NOW)
        .with("expiresAt", Value::Null);
    sign_statement(Value::Obj(p), &w.owner).unwrap()
}

fn directory(w: &World, grants: Vec<Value>, revocations: Value) -> Value {
    Value::Obj(
        Obj::new()
            .with("ownerId", &w.owner_id)
            .with("ownerChain", Value::Arr(vec![genesis(w)]))
            .with("revocations", revocations)
            .with(
                "certs",
                Value::Arr(vec![cert(w, A, &w.a, A, 0.0), cert(w, B, &w.b, B, 0.0)]),
            )
            .with("grants", Value::Arr(grants)),
    )
}

fn party(pid: &str, who: &Identity) -> (String, String) {
    (pid.to_string(), b64(&who.box_pub))
}

fn seal_ab(w: &World, text: &str, scope: &str) -> Value {
    let body = Value::Obj(Obj::new().with("text", text));
    seal_envelope(
        SealInput {
            id: format!("m_{}", "a".repeat(26)),
            owner_id: w.owner_id.clone(),
            from: A.into(),
            to: B.into(),
            kind: "message".into(),
            seq: 1.0,
            body: &body,
            reference: None,
            scope: Some(scope.into()),
            grant_id: Some("g_1111111111111111".into()),
            expires_at: None,
            created_at: NOW,
            sender: &w.a,
            recipients: vec![party(A, &w.a), party(B, &w.b), party(&w.owner_id, &w.owner)],
        },
        &mut catcher::crypto::random_bytes,
    )
    .unwrap()
}

#[test]
fn frozen_vectors() {
    let w = world();
    let k = public_keys(&w.owner);
    assert_eq!(k.sign_pub, "FiDeeNlCobI2KraFUYA5Qhh9n92fb9R0bdkubPLj4uk");
    assert_eq!(k.box_pub, "_ZzNaNjdHKQGU-z1zJZFp8sklb-e7d0-Aj9R80IDFE8");
    assert_eq!(w.owner_id, "o_bftqn1ntzbdcw2szt530");
    assert_eq!(fingerprint(&k.sign_pub, &k.box_pub), "4RNJ-70Y7-RZ6B-F3JS");
    assert_eq!(
        recovery_code(&w.owner.seed),
        "040G2-08104-0G208-1040G-20810-40G20-81040-G2081-040G2-08104-0KX4R"
    );
    let body = Value::Obj(Obj::new().with("question", "merge?"));
    let env = seal_envelope(
        SealInput {
            id: format!("m_{}", "0".repeat(26)),
            owner_id: w.owner_id.clone(),
            from: A.into(),
            to: w.owner_id.clone(),
            kind: "ask".into(),
            seq: 1.0,
            body: &body,
            reference: None,
            scope: None,
            grant_id: None,
            expires_at: None,
            created_at: NOW,
            sender: &w.a,
            recipients: vec![party(&w.owner_id, &w.owner), party(A, &w.a)],
        },
        &mut det("v"),
    )
    .unwrap();
    assert_eq!(
        env.str("ctHash"),
        Some("rVb4kYxzj1B2sSvruk899veoqaOo282-IOs2ZdkvAkY")
    );
    assert_eq!(
        env.str("sig"),
        Some(
            "8g1wR91ut9rhrPtX83yPuvshra2k3WXjcf6jwnFQNt5dJAQ-LnYmlW5n03tCiRAfL5WtE-8av3_-GD9W8noPAg"
        )
    );
    let pairing = Obj::new()
        .with("kind", "pairing")
        .with("ownerId", &w.owner_id)
        .with("issuedAt", NOW);
    assert_eq!(
        sign_statement(Value::Obj(pairing), &w.owner)
            .unwrap()
            .str("sig"),
        Some(
            "GTkP2wrWAKF11LFxPdcyacbmpVrKD9XL2jyixpG1eBJ4HMfWXuTmQCD5BkU-IMoUjCsnd8x6x1JHu2JSU6TnBA"
        )
    );
    // the owner and the sender can open it
    assert_eq!(open_envelope(&env, &w.owner_id, &w.owner).unwrap(), body);
    assert_eq!(open_envelope(&env, A, &w.a).unwrap(), body);
}

#[test]
fn recovery_code_round_trip() {
    let w = world();
    let code = recovery_code(&w.owner.seed);
    assert_eq!(
        seed_from_recovery_code(&code.to_lowercase()).unwrap(),
        w.owner.seed
    );
    let swapped = if &code[3..4] == "Z" { "Y" } else { "Z" };
    let typo = format!("{}{}{}", &code[..3], swapped, &code[4..]);
    assert!(seed_from_recovery_code(&typo).unwrap_err().contains("typo"));
}

#[test]
fn recipients_open_and_outsiders_cannot() {
    let w = world();
    let env = seal_ab(&w, "hello", "message");
    verify_envelope(&env, &b64(&w.a.sign_pub)).unwrap();
    for (pid, who) in [(B, &w.b), (A, &w.a)] {
        assert_eq!(
            open_envelope(&env, pid, who).unwrap().str("text"),
            Some("hello")
        );
    }
    assert_eq!(
        open_envelope(&env, &w.owner_id, &w.owner)
            .unwrap()
            .str("text"),
        Some("hello")
    );
    assert!(open_envelope(&env, B, &id(9)).is_err());
    assert!(open_envelope(&env, "a_zzzzzzzzzzzzzzzz", &id(9)).is_err());
}

#[test]
fn tampering_is_caught() {
    let w = world();
    let env = seal_ab(&w, "hello", "message");
    let key = b64(&w.a.sign_pub);
    let edit = |f: &dyn Fn(&mut Obj)| {
        let mut e = env.as_obj().unwrap().clone();
        f(&mut e);
        verify_envelope(&Value::Obj(e), &key).unwrap_err()
    };
    let owner_id = w.owner_id.clone();
    assert!(
        edit(&|e| {
            let wraps: Vec<Value> = e
                .get("wraps")
                .unwrap()
                .as_arr()
                .unwrap()
                .iter()
                .filter(|x| !x.is_str(&owner_id) && x.str("to") != Some(&owner_id))
                .cloned()
                .collect();
            e.set("wraps", Value::Arr(wraps));
        })
        .contains("not readable by")
    );
    assert!(
        edit(&|e| {
            let mut core = e.get("core").unwrap().as_obj().unwrap().clone();
            core.set("scope", "calendar.read".into());
            e.set("core", Value::Obj(core));
        })
        .contains("signature")
    );
    let other = seal_ab(&w, "evil", "message");
    assert!(edit(&|e| e.set("ct", other.get("ct").unwrap().clone())).contains("hash"));
    assert!(edit(&|e| e.set("sig", other.get("sig").unwrap().clone())).contains("signature"));
}

#[test]
fn policy_grants_and_releases() {
    let w = world();
    let pin_keys = public_keys(&w.owner);
    let pin = (
        w.owner_id.as_str(),
        pin_keys.sign_pub.as_str(),
        pin_keys.box_pub.as_str(),
    );
    let env = seal_ab(&w, "hello", "message");
    let no_grant = build_trust(&directory(&w, vec![], Value::Null), pin, 0.0, NOW).unwrap();
    assert_eq!(
        check_envelope(&no_grant, &env, None, NOW)
            .unwrap_err()
            .policy_code(),
        Some("no_grant")
    );
    let trust = build_trust(
        &directory(&w, vec![grant(&w, false)], Value::Null),
        pin,
        0.0,
        NOW,
    )
    .unwrap();
    check_envelope(&trust, &env, None, NOW).unwrap();
    let wrong = seal_ab(&w, "hello", "calendar.read");
    assert!(
        check_envelope(&trust, &wrong, None, NOW)
            .unwrap_err()
            .message()
            .contains("does not cover")
    );

    let held = build_trust(
        &directory(&w, vec![grant(&w, true)], Value::Null),
        pin,
        0.0,
        NOW,
    )
    .unwrap();
    assert_eq!(
        check_envelope(&held, &env, None, NOW)
            .unwrap_err()
            .policy_code(),
        Some("held")
    );
    let release = |who: &Identity, e: &Value| {
        let core = e.get("core").unwrap();
        let p = Obj::new()
            .with("kind", "release")
            .with("ownerId", &w.owner_id)
            .with("envelopeId", core.get("id").cloned())
            .with("ctHash", e.get("ctHash").cloned())
            .with("issuedAt", NOW);
        sign_statement(Value::Obj(p), who).unwrap()
    };
    check_envelope(&held, &env, Some(&release(&w.owner, &env)), NOW).unwrap();
    assert!(
        check_envelope(&held, &env, Some(&release(&w.a, &env)), NOW)
            .unwrap_err()
            .message()
            .contains("signed by the expected key")
    );
    let other = seal_ab(&w, "different", "message");
    assert!(
        check_envelope(&held, &other, Some(&release(&w.owner, &env)), NOW)
            .unwrap_err()
            .message()
            .contains("does not match")
    );
}

#[test]
fn revocations_and_floor() {
    let w = world();
    let pk = public_keys(&w.owner);
    let pin = (
        w.owner_id.as_str(),
        pk.sign_pub.as_str(),
        pk.box_pub.as_str(),
    );
    let rev = |version: f64, agents: Vec<Value>| {
        let p = Obj::new()
            .with("kind", "revocations")
            .with("ownerId", &w.owner_id)
            .with("version", version)
            .with("agents", Value::Arr(agents))
            .with("grants", Value::Arr(vec![]))
            .with("issuedAt", NOW);
        sign_statement(Value::Obj(p), &w.owner).unwrap()
    };
    let t = build_trust(
        &directory(&w, vec![], rev(2.0, vec![B.into()])),
        pin,
        0.0,
        NOW,
    )
    .unwrap();
    assert!(t.agent(B).is_none());
    assert_eq!(t.revocation_version, 2.0);
    let err = build_trust(&directory(&w, vec![], rev(1.0, vec![])), pin, 2.0, NOW).unwrap_err();
    assert!(err.message().contains("older revocation list"));
    // a cert issued after revocation v3 rejects a directory with no list; an agent named owner is never trusted
    let mut d = directory(&w, vec![], Value::Null);
    if let Value::Obj(o) = &mut d {
        o.set("certs", Value::Arr(vec![cert(&w, A, &w.a, "a", 3.0)]));
    }
    assert!(
        build_trust(&d, pin, 0.0, NOW)
            .unwrap_err()
            .message()
            .contains("older revocation list")
    );
    if let Value::Obj(o) = &mut d {
        o.set("certs", Value::Arr(vec![cert(&w, A, &w.a, "owner", 0.0)]));
    }
    assert!(build_trust(&d, pin, 0.0, NOW).unwrap().agent(A).is_none());
}

#[test]
fn owner_key_rotation() {
    let w = world();
    let next = id(7);
    let link = |signer: &Identity, keys: &Identity| {
        let p = keys_obj(
            Obj::new()
                .with("kind", "owner-key")
                .with("ownerId", &w.owner_id)
                .with("seq", 1.0),
            keys,
        )
        .with("issuedAt", NOW);
        sign_statement(Value::Obj(p), signer).unwrap()
    };
    let chain = Value::Arr(vec![genesis(&w), link(&w.owner, &next)]);
    assert_eq!(
        verify_owner_chain(&chain, &w.owner_id).unwrap().sign_pub,
        b64(&next.sign_pub)
    );
    let bad = Value::Arr(vec![genesis(&w), link(&id(9), &id(9))]);
    assert!(
        verify_owner_chain(&bad, &w.owner_id)
            .unwrap_err()
            .contains("signed by the expected key")
    );
}

#[test]
fn statements_reject_wrong_kind_or_signer() {
    let w = world();
    let s = sign_statement(
        Value::Obj(
            Obj::new()
                .with("kind", "pairing")
                .with("ownerId", &w.owner_id)
                .with("issuedAt", NOW),
        ),
        &w.owner,
    )
    .unwrap();
    let owner_key = b64(&w.owner.sign_pub);
    assert!(verify_statement(&s, "pairing", &owner_key).is_ok());
    assert!(
        verify_statement(&s, "cert", &owner_key)
            .unwrap_err()
            .contains("expected a cert")
    );
    assert!(
        verify_statement(&s, "pairing", &b64(&w.a.sign_pub))
            .unwrap_err()
            .contains("expected key")
    );
    let mut tampered = s.as_obj().unwrap().clone();
    let mut p = s.get("payload").unwrap().as_obj().unwrap().clone();
    p.set("issuedAt", Value::Num(NOW + 1.0));
    tampered.set("payload", Value::Obj(p));
    assert!(
        verify_statement(&Value::Obj(tampered), "pairing", &owner_key)
            .unwrap_err()
            .contains("invalid")
    );
}

#[test]
fn request_auth_bytes() {
    use catcher::auth::{auth_bytes, sign_request};
    let w = world();
    let header = sign_request(
        A,
        &w.a.sign_secret,
        "POST",
        "/v1/envelopes",
        b"{\"x\":1}",
        NOW,
    );
    let parts: Vec<&str> = header.split('.').collect();
    assert_eq!((parts[0], parts[1]), (A, "1700000000000"));
    let sig = catcher::bytes::unb64(parts[2]).unwrap();
    let bytes = auth_bytes("post", "/v1/envelopes", NOW, b"{\"x\":1}");
    assert!(catcher::crypto::verify(&sig, &bytes, &w.a.sign_pub));
    assert!(!catcher::crypto::verify(
        &sig,
        &auth_bytes("POST", "/v1/ack", NOW, b"{\"x\":1}"),
        &w.a.sign_pub
    ));
}
