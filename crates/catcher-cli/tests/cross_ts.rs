// Cross-implementation check against packages/protocol (TypeScript, run by Node): an envelope and statements sealed
// here verify and open there, and the reverse. Skipped when Node or the workspace's node_modules are missing.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use catcher::bytes::b64;
use catcher::envelope::{SealInput, open_envelope, seal_envelope, verify_envelope};
use catcher::identity::{identity_from_seed, owner_id_for};
use catcher::json::{self, Obj, Value};
use catcher::statements::{sign_statement, verify_statement};

const SCRIPT: &str = r#"
import { b64, identityFromSeed, openEnvelope, ownerIdFor, sealEnvelope, signStatement, verifyEnvelope, verifyStatement } from './packages/protocol/src/index.ts';
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const owner = identityFromSeed(new Uint8Array(32).fill(1));
const agent = identityFromSeed(new Uint8Array(32).fill(2));
const ownerId = ownerIdFor(b64(owner.signPub));
const A = 'a_1111111111111111';
verifyEnvelope(input.envelope, b64(agent.signPub));
const asOwner = openEnvelope(input.envelope, { id: ownerId, ...owner });
const asAgent = openEnvelope(input.envelope, { id: A, ...agent });
verifyStatement(input.statement, 'cert', b64(owner.signPub));
const envelope = sealEnvelope({
  id: 'm_' + 'b'.repeat(26), ownerId, from: ownerId, to: A, type: 'answer', seq: 7, ref: input.envelope.core.id,
  body: { answer: 'ja ✓ 😀', note: 'line\nbreak "quoted"', n: 12 }, sender: owner,
  recipients: [{ id: A, boxPub: b64(agent.boxPub) }, { id: ownerId, boxPub: b64(owner.boxPub) }],
});
const statement = signStatement({ kind: 'grant', ownerId, grantId: 'g_x', from: A, to: 'a_2', scopes: ['message', 'é'], requireApproval: false, issuedAt: 1700000000000, expiresAt: null, 'ü': 1, 'Z': 2 }, owner);
process.stdout.write(JSON.stringify({ asOwner, asAgent, envelope, statement }));
"#;

#[test]
fn rust_and_typescript_interoperate() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    if !root.join("node_modules/@noble").exists()
        && !root.join("packages/protocol/node_modules").exists()
    {
        eprintln!("skipped: run pnpm install first");
        return;
    }
    let owner = identity_from_seed(&[1; 32]).unwrap();
    let agent = identity_from_seed(&[2; 32]).unwrap();
    let owner_id = owner_id_for(&b64(&owner.sign_pub));
    let a = "a_1111111111111111";
    let body = json::parse(
        r#"{"question":"merge PR ✓ \"12\"?\n😀","choices":["yes","no"],"z":{"b":1,"a":-3}}"#,
    )
    .unwrap();
    let envelope = seal_envelope(
        SealInput {
            id: format!("m_{}", "a".repeat(26)),
            owner_id: owner_id.clone(),
            from: a.into(),
            to: owner_id.clone(),
            kind: "ask".into(),
            seq: 3.0,
            body: &body,
            reference: None,
            scope: None,
            grant_id: None,
            expires_at: Some(1_900_000_000_000.0),
            created_at: 1_700_000_000_000.0,
            sender: &agent,
            recipients: vec![
                (owner_id.clone(), b64(&owner.box_pub)),
                (a.into(), b64(&agent.box_pub)),
            ],
        },
        &mut catcher::crypto::random_bytes,
    )
    .unwrap();
    let cert = Obj::new()
        .with("kind", "cert")
        .with("ownerId", &owner_id)
        .with("agentId", a)
        .with("name", "ünï-😀")
        .with("expiresAt", 1_900_000_000_000.0)
        .with("revocationFloor", 0.0)
        .with("\u{FFFD}", "after astral in UTF-16")
        .with("\u{10000}", "astral");
    let statement = sign_statement(Value::Obj(cert), &owner).unwrap();
    let input = Value::Obj(
        Obj::new()
            .with("envelope", envelope)
            .with("statement", statement),
    );

    let mut child = match Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            &SCRIPT.replace("require('node:fs')", "(await import('node:fs'))"),
        ])
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => {
            eprintln!("skipped: node is not installed");
            return;
        }
    };
    child
        .stdin
        .take()
        .unwrap()
        .write_all(json::stringify(&input).as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "node side failed");
    let res = json::parse(&String::from_utf8(out.stdout).unwrap()).unwrap();
    // TS opened what Rust sealed, as both recipients
    assert_eq!(res.get("asOwner"), Some(&body));
    assert_eq!(res.get("asAgent"), Some(&body));
    // Rust verifies and opens what TS sealed
    let env = res.get("envelope").unwrap();
    verify_envelope(env, &b64(&owner.sign_pub)).unwrap();
    let opened = open_envelope(env, a, &agent).unwrap();
    assert_eq!(opened.str("answer"), Some("ja ✓ 😀"));
    assert_eq!(
        json::stringify(&opened),
        r#"{"answer":"ja ✓ 😀","note":"line\nbreak \"quoted\"","n":12}"#
    );
    let grant = verify_statement(
        res.get("statement").unwrap(),
        "grant",
        &b64(&owner.sign_pub),
    )
    .unwrap();
    assert_eq!(grant.str("grantId"), Some("g_x"));
}
