// Agent-first registration, agent side. `catcher register` makes a fresh key and code, saves them in pending.json
// (before the relay hears of them), posts the self-signed enroll statement and exits. The owner claims the agent in the
// app; this side then fetches the claim, checks it (agent steps 1–6 in packages/protocol/src/enroll.ts) and writes
// state.json. Any claim that fails steps 1–4 deletes the registration: one guess only.

use crate::agent::valid_name;
use crate::api::Api;
use crate::auth::now_ms;
use crate::bytes::{b64, unb64};
use crate::crypto::random_bytes;
use crate::enroll::{
    EnrollInput, agent_id_for, enroll_code, enroll_link, enroll_parts, open_claim, sign_enroll,
};
use crate::error::Error;
use crate::identity::{Identity, fingerprint, identity_from_seed};
use crate::json::{Obj, Value, is, to_js_string, utf16_prefix};
use crate::statements::verify_statement;
use crate::store::{AgentState, Profile};

/// Exit code when a claim fails verification (the code was used by someone who did not have it, or the relay lied).
pub const EXIT_BAD_CLAIM: i32 = 7;
/// How long a finaliser waits for another one holding the lock.
const LOCK_WAIT_MS: u64 = 15_000;
const LOOKUP_RETRIES: usize = 3;

pub const BAD_CLAIM_TEXT: &str = "This code was claimed by someone who did not have it, or the relay tampered. Nothing was trusted. Run register again.";

/// The registration in progress, as kept in pending.json.
pub struct Pending {
    pub raw: Obj,
}

impl Pending {
    fn text(&self, k: &str) -> String {
        match self.raw.get(k) {
            Some(Value::Str(s)) => s.clone(),
            other => to_js_string(other),
        }
    }
    pub fn name(&self) -> String {
        self.text("name")
    }
    pub fn server(&self) -> String {
        self.text("server")
    }
    pub fn lookup(&self) -> String {
        self.text("lookup")
    }
    fn secret(&self) -> String {
        self.text("secret")
    }
    pub fn agent_id(&self) -> String {
        self.text("agentId")
    }
    pub fn expires_at(&self) -> f64 {
        self.raw.get("expiresAt").and_then(num).unwrap_or(0.0)
    }
    fn posted(&self) -> bool {
        matches!(self.raw.get("posted"), Some(Value::Bool(true)))
    }
    pub fn identity(&self) -> Result<Identity, Error> {
        Ok(identity_from_seed(&unb64(&self.text("seed"))?)?)
    }
    /// XXXX-XXXX-XXXX-XXXX, recomputed from the parts and this agent's keys.
    pub fn code(&self) -> Result<String, Error> {
        let id = self.identity()?;
        Ok(enroll_code(
            &self.lookup(),
            &self.secret(),
            &b64(&id.sign_pub),
            &b64(&id.box_pub),
        )
        .code)
    }
    pub fn link(&self) -> Result<String, Error> {
        // the website, never the relay: the relay must not be the page that receives the code
        Ok(enroll_link(&crate::store::site(), &self.code()?))
    }
    pub fn expired(&self) -> bool {
        self.expires_at() <= now_ms()
    }
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Num(n) => Some(*n),
        _ => None,
    }
}

/// `text` cut to `max` UTF-16 units (the relay counts like JS `.length` and refuses longer).
pub fn clip(text: &str, max: usize) -> String {
    utf16_prefix(text, max).0.to_string()
}

pub struct NewRegistration<'a> {
    pub name: &'a str,
    pub server: &'a str,
    pub device: &'a str,
    pub provider: &'a str,
}

/// Fresh seed and code, saved before anything is sent.
fn fresh(profile: &Profile, input: &NewRegistration) -> Result<Pending, Error> {
    let seed = random_bytes(32);
    let id = identity_from_seed(&seed)?;
    let (lookup, secret) = enroll_parts(&random_bytes(10))?;
    let now = now_ms();
    let raw = Obj::new()
        .with("name", input.name)
        .with("server", input.server.trim_end_matches('/'))
        .with("seed", b64(&seed))
        .with("agentId", agent_id_for(&b64(&id.sign_pub)))
        .with("lookup", lookup)
        .with("secret", secret)
        .with("device", input.device)
        .with("provider", input.provider)
        .with("issuedAt", now)
        .with("expiresAt", now + crate::enroll::ENROLL_TTL_MS)
        .with("posted", false);
    let pending = Pending { raw };
    profile.save_pending(&pending.raw)?;
    Ok(pending)
}

fn statement(p: &Pending, id: &Identity) -> Result<Value, Error> {
    Ok(sign_enroll(
        &EnrollInput {
            lookup: &p.lookup(),
            name: &p.name(),
            device: &p.text("device"),
            provider: &p.text("provider"),
            issued_at: p.raw.get("issuedAt").and_then(num).unwrap_or(0.0),
        },
        id,
    )?)
}

/// POST the enroll statement until the relay holds it (a taken lookup gets a new one, at most 3 times).
fn post(profile: &Profile, p: &mut Pending) -> Result<(), Error> {
    let id = p.identity()?;
    let api = Api::new(&p.server(), None);
    for attempt in 0..=LOOKUP_RETRIES {
        let body = Value::Obj(Obj::new().with("statement", statement(p, &id)?));
        match api.call("POST", "/v1/enroll", Some(&body), false) {
            Ok(_) => {
                // the claim window is ours: issuedAt + TTL, whatever expiry the relay reports
                p.raw.set("posted", Value::Bool(true));
                profile.save_pending(&p.raw)?;
                return Ok(());
            }
            Err(e) if e.api_code() == Some("lookup_taken") && attempt < LOOKUP_RETRIES => {
                let (lookup, secret) = enroll_parts(&random_bytes(10))?;
                p.raw.set("lookup", lookup.into());
                p.raw.set("secret", secret.into());
                // a new lookup is a new statement: its time (and so its claim window) starts now
                let now = now_ms();
                p.raw.set("issuedAt", Value::Num(now));
                p.raw
                    .set("expiresAt", Value::Num(now + crate::enroll::ENROLL_TTL_MS));
                profile.save_pending(&p.raw)?;
            }
            Err(e) => return Err(e),
        }
    }
    Err(Error::plain(
        "could not find a free code — run register again",
    ))
}

pub enum Start {
    /// a new code, just posted
    New(Pending),
    /// the code from an earlier run: still open, or expired here but not yet confirmed unclaimed by the relay
    Again(Pending),
    /// this profile already has a registered agent
    Registered(AgentState),
}

/// `catcher register`: reuse the open registration or start a fresh one. `name` None means "only resume".
pub fn start(profile: &Profile, input: Option<&NewRegistration>) -> Result<Start, Error> {
    let _lock = profile.lock(LOCK_WAIT_MS)?;
    if profile.exists() {
        return Ok(Start::Registered(profile.load()?));
    }
    let mut pending = profile.load_pending().map(|raw| Pending { raw });
    if let (Some(p), Some(input)) = (&pending, input)
        && (p.name() != input.name || p.server() != input.server.trim_end_matches('/'))
    {
        // a different registration was asked for: the old code is dropped (it expires on the relay)
        profile.delete_pending()?;
        pending = None;
    }
    match (pending, input) {
        // expired here: it may still have been claimed in time (or posted with the answer lost), so the caller asks
        // the relay before anything is dropped
        (Some(p), _) if p.expired() => Ok(Start::Again(p)),
        (Some(mut p), _) => {
            if !p.posted() {
                post(profile, &mut p)?;
                return Ok(Start::New(p));
            }
            Ok(Start::Again(p))
        }
        (None, Some(input)) => {
            let mut p = fresh(profile, input)?;
            post(profile, &mut p)?;
            Ok(Start::New(p))
        }
        (None, None) => Err(Error::usage("catcher register --name <agent name>")),
    }
}

pub enum Poll {
    Waiting,
    /// the relay no longer has the code (expired or never arrived)
    Expired,
    Claimed {
        claim: Value,
        cert: Value,
    },
}

pub fn poll(p: &Pending) -> Result<Poll, Error> {
    let id = p.identity()?;
    let api = Api::new(&p.server(), Some((&p.agent_id(), id.sign_secret)));
    match api.call("GET", &format!("/v1/enroll/{}", p.lookup()), None, true) {
        Ok(res) if is(res.get("status"), "claimed") => Ok(Poll::Claimed {
            claim: res.get("claim").cloned().unwrap_or(Value::Null),
            cert: res.get("cert").cloned().unwrap_or(Value::Null),
        }),
        Ok(_) => Ok(Poll::Waiting),
        Err(Error::Api {
            status: 404 | 410, ..
        }) => Ok(Poll::Expired),
        Err(e) => Err(e),
    }
}

fn changed_meanwhile() -> Error {
    Error::cli(
        "the registration changed while this command ran (another catcher process started a new one) — run: catcher register --wait",
        6,
    )
}

/// Forget the registration for `lookup` once the relay said it is gone — but only if it is still the one in
/// pending.json (another process may have started a new one meanwhile).
pub fn drop_pending(profile: &Profile, lookup: &str) -> Result<(), Error> {
    let _lock = profile.lock(LOCK_WAIT_MS)?;
    if profile
        .load_pending()
        .is_some_and(|raw| Pending { raw }.lookup() == lookup)
    {
        profile.delete_pending()?;
    }
    Ok(())
}

/// Steps 1–6 for a claim the relay served for `lookup`. Takes the lock; a second finaliser finds state.json and stops.
pub fn finalise(
    profile: &Profile,
    lookup: &str,
    claim: &Value,
    cert: &Value,
) -> Result<AgentState, Error> {
    let _lock = profile.lock(LOCK_WAIT_MS)?;
    if profile.exists() {
        return profile.load();
    }
    let Some(raw) = profile.load_pending() else {
        return Err(Error::cli(
            "no registration in progress — run: catcher register --name <name>",
            6,
        ));
    };
    let p = Pending { raw };
    if p.lookup() != lookup {
        // the claim was fetched for a registration that is no longer the current one: judge nothing, drop nothing
        return Err(changed_meanwhile());
    }
    let id = p.identity()?;
    // 1–4: owner-signed, for this code and these keys, and it carries this code's secret
    let by = match open_claim(claim, &p.agent_id(), &p.lookup(), &p.secret(), &id) {
        Ok(by) => by,
        Err(_) => {
            profile.delete_pending()?;
            return Err(Error::cli(BAD_CLAIM_TEXT, EXIT_BAD_CLAIM));
        }
    };
    // 5: the cert verifies under the owner key that signed the claim and is for exactly this agent. The name is the
    // owner's pick: it starts as the one this agent asked for, and the owner may have chosen another.
    let mut name = None;
    let cert_ok = verify_statement(cert, "cert", &by.owner_sign_pub).is_ok_and(|c| {
        name = c.str("name").filter(|n| valid_name(n)).map(String::from);
        is(c.get("ownerId"), &by.owner_id)
            && is(c.get("agentId"), &p.agent_id())
            && name.is_some()
            && is(c.get("signPub"), &b64(&id.sign_pub))
            && is(c.get("boxPub"), &b64(&id.box_pub))
    });
    let (true, Some(name)) = (cert_ok, name) else {
        // the claim is genuine; a bad cert is the relay's doing and may be fixed on the next try
        return Err(Error::plain(
            "the owner approved this agent, but the relay served no valid certificate yet — run: catcher register --wait",
        ));
    };
    // 6: pin the owner key that signed the claim
    let state = AgentState {
        raw: Obj::new()
            .with("server", p.server())
            .with("agentId", p.agent_id())
            .with("ownerId", by.owner_id.as_str())
            .with("name", name.as_str())
            .with("seed", p.text("seed"))
            .with(
                "ownerPin",
                Obj::new()
                    .with("signPub", by.owner_sign_pub.as_str())
                    .with("boxPub", by.owner_box_pub.as_str()),
            )
            .with("revocationVersion", 0.0)
            .with("seq", 0.0),
    };
    profile.save(&state)?;
    profile.delete_pending()?;
    Ok(state)
}

/// Lazy finalise for any other command: one poll; Ok(state) once registered, otherwise an exit-6 error that names the
/// code again (or exit 7 when the claim fails verification).
pub fn finalise_once(profile: &Profile) -> Result<AgentState, Error> {
    let Some(raw) = profile.load_pending() else {
        return profile.load();
    };
    let p = Pending { raw };
    let not_yet = |p: &Pending| -> Error {
        let code = p.code().unwrap_or_default();
        let link = p.link().unwrap_or_default();
        Error::cli(
            format!(
                "not registered yet — your user has not approved {} yet. Code: {code}  Link: {link}  (show it only to your user; then run: catcher register --wait)",
                p.name()
            ),
            6,
        )
    };
    // always ask the relay: a claim that arrived in time finalises even after the code expired here
    match poll(&p) {
        Ok(Poll::Claimed { claim, cert }) => finalise(profile, &p.lookup(), &claim, &cert),
        Ok(Poll::Expired) if p.posted() || p.expired() => {
            drop_pending(profile, &p.lookup())?;
            Err(Error::cli(
                "not registered — the registration code expired. Run: catcher register --name <name>",
                6,
            ))
        }
        Ok(_) | Err(_) => Err(not_yet(&p)),
    }
}

pub fn owner_fingerprint(state: &AgentState) -> String {
    let (s, b) = state.pin();
    fingerprint(&s, &b)
}
