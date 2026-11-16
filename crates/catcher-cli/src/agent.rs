// Agent side: verified directory, sending, inbox (verify + decrypt), ack, waiting on answers.
// Every envelope is checked against owner-signed certs and grants locally; the relay is not trusted.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use crate::api::Api;
use crate::auth::now_ms;
use crate::bytes::unb64;
use crate::crypto::random_bytes;
use crate::envelope::{OWNER_REQUEST_TYPES, SealInput, open_envelope, seal_envelope};
use crate::error::Error;
use crate::identity::{Identity, fingerprint, identity_from_seed, public_keys, random_id};
use crate::json::{self, Obj, Value, is, number_to_string, strict_eq, to_js_string, truthy};
use crate::policy::{Trust, build_trust, check_envelope};
use crate::store::{AgentState, Profile};

/// A verified, decrypted message. Fields stay JSON so output matches the TS CLI byte for byte.
#[derive(Clone, Debug)]
pub struct Received {
    pub id: Option<Value>,
    pub cursor: Option<Value>,
    pub kind: Option<Value>,
    pub from_id: Option<Value>,
    pub from_name: String,
    pub to: Option<Value>,
    pub reference: Option<Value>,
    pub scope: Option<Value>,
    pub grant_id: Option<Value>,
    pub created_at: Option<Value>,
    pub expires_at: Option<Value>,
    pub received_at: Option<Value>,
    /// agent traffic only: (grant id, the grant needs an owner release — which this message then carried)
    pub grant: Option<(String, bool)>,
    pub body: Value,
}

fn put(o: &mut Obj, k: &str, v: &Option<Value>) {
    if let Some(v) = v {
        o.set(k, v.clone());
    }
}

impl Received {
    pub fn to_value(&self) -> Value {
        let mut o = Obj::new();
        put(&mut o, "id", &self.id);
        put(&mut o, "cursor", &self.cursor);
        put(&mut o, "type", &self.kind);
        let mut from = Obj::new();
        put(&mut from, "id", &self.from_id);
        from.set("name", self.from_name.clone().into());
        o.set("from", Value::Obj(from));
        put(&mut o, "to", &self.to);
        put(&mut o, "ref", &self.reference);
        put(&mut o, "scope", &self.scope);
        put(&mut o, "grantId", &self.grant_id);
        put(&mut o, "createdAt", &self.created_at);
        put(&mut o, "expiresAt", &self.expires_at);
        put(&mut o, "receivedAt", &self.received_at);
        o.set("body", self.body.clone());
        Value::Obj(o)
    }

    pub fn id_str(&self) -> String {
        to_js_string(self.id.as_ref())
    }

    pub fn kind_is(&self, t: &str) -> bool {
        is(self.kind.as_ref(), t)
    }
}

#[derive(Clone, Debug)]
pub struct Rejected {
    pub id: Option<Value>,
    pub cursor: Option<Value>,
    pub from: Option<Value>,
    pub reason: String,
    pub code: String,
}

impl Rejected {
    pub fn to_value(&self) -> Value {
        let mut o = Obj::new();
        put(&mut o, "id", &self.id);
        put(&mut o, "cursor", &self.cursor);
        put(&mut o, "from", &self.from);
        o.set("reason", self.reason.clone().into());
        o.set("code", self.code.clone().into());
        Value::Obj(o)
    }
}

pub struct InboxPage {
    pub received: Vec<Received>,
    pub rejected: Vec<Rejected>,
    /// highest cursor on the page (or `after` when empty)
    pub last_cursor: f64,
    /// the page was full: there may be more
    pub full: bool,
}

/// This agent's sent messages by id: (type, toId). Replies and answers must point at one of them.
pub type Outgoing = HashMap<String, (Option<Value>, Option<Value>)>;

/// Agent names; `owner` is reserved.
pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    name != "owner"
        && !b.is_empty()
        && b.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub struct SendOpts {
    pub scope: Option<String>,
    pub reference: Option<String>,
    pub id: Option<String>,
    pub grant_id: Option<String>,
}

pub struct Sent {
    pub id: String,
    pub held: Option<Value>,
    pub duplicate: Option<Value>,
}

impl Sent {
    pub fn to_value(&self) -> Value {
        let mut o = Obj::new().with("id", &self.id);
        put(&mut o, "held", &self.held);
        put(&mut o, "duplicate", &self.duplicate);
        Value::Obj(o)
    }
}

#[derive(Default, Clone)]
pub struct TrustOpts {
    pub refresh: bool,
    /// None is `undefined`
    pub known_version: Option<Value>,
}

pub struct AgentClient<'p> {
    pub state: AgentState,
    pub identity: Identity,
    pub api: Api,
    profile: &'p Profile,
    seen: HashSet<String>,
    outgoing: Option<Outgoing>,
    cached_trust: Option<Rc<Trust>>,
    cached_version: Option<Value>,
}

impl<'p> AgentClient<'p> {
    pub fn new(
        state: AgentState,
        profile: &'p Profile,
        seen: HashSet<String>,
        outgoing: Option<Outgoing>,
    ) -> Result<Self, Error> {
        let identity = identity_from_seed(&unb64(&state.seed())?)?;
        let api = Api::new(
            &state.server(),
            Some((&state.agent_id(), identity.sign_secret)),
        );
        Ok(AgentClient {
            state,
            identity,
            api,
            profile,
            seen,
            outgoing,
            cached_trust: None,
            cached_version: Some(Value::Num(0.0)),
        })
    }

    /// Remember a request this process just sent, so an answer to it passes the `outgoing` check in this same run
    /// (the TS CLI snapshots history before sending, which makes its inline `--wait` reject the answer).
    pub fn note_sent(&mut self, id: &str, kind: &str, to_id: &str) {
        if let Some(outgoing) = &mut self.outgoing {
            outgoing.insert(id.to_string(), (Some(kind.into()), Some(to_id.into())));
        }
    }

    pub fn agent_fingerprint(&self) -> String {
        let k = public_keys(&self.identity);
        fingerprint(&k.sign_pub, &k.box_pub)
    }

    pub fn owner_fingerprint(&self) -> String {
        let (s, b) = self.state.pin();
        fingerprint(&s, &b)
    }

    pub fn me(&self) -> Result<Value, Error> {
        self.api.call("GET", "/v1/me", None, true)
    }

    fn save(&self) -> Result<(), Error> {
        self.profile.save(&self.state)
    }

    /// Verified view of certs and grants. Uses the on-disk cache when its version is current (the relay answers
    /// "unchanged" without sending the directory). `known_version` comes from the inbox answer.
    pub fn trust(&mut self, opts: TrustOpts) -> Result<Rc<Trust>, Error> {
        let known = opts.known_version.as_ref();
        let hint_matches = known.is_none() || strict_eq(known, self.cached_version.as_ref());
        if let Some(t) = &self.cached_trust
            && !opts.refresh
            && hint_matches
        {
            return Ok(t.clone());
        }
        let cached = self.profile.load_directory().filter(|c| truthy(Some(c)));
        let entry = match &cached {
            Some(c) if !opts.refresh && strict_eq(known, c.get("version")) => c.clone(),
            _ => {
                let mut known_q = "0".to_string();
                if let (Some(c), false) = (&cached, opts.refresh) {
                    known_q = to_js_string(c.get("version"));
                }
                let res =
                    self.api
                        .call("GET", &format!("/v1/directory?known={known_q}"), None, true)?;
                let unchanged = res.as_obj().is_some_and(|o| o.has("unchanged"));
                match (unchanged, &cached) {
                    (true, Some(c)) => c.clone(),
                    (true, None) => {
                        return self.trust(TrustOpts {
                            refresh: true,
                            known_version: None,
                        });
                    }
                    (false, _) => {
                        // `{version: res.version, directory: res}`; an undefined version is dropped by JSON.stringify
                        let mut e = Obj::new();
                        if let Some(v) = res.get("version") {
                            e.set("version", v.clone());
                        }
                        e.set("directory", res.clone());
                        let e = Value::Obj(e);
                        self.profile.save_directory(&e)?;
                        e
                    }
                }
            }
        };
        let directory = entry
            .get("directory")
            .ok_or("Cannot read properties of undefined (reading 'ownerId')")?;
        let version = entry.get("version").cloned();
        let (pin_sign, pin_box) = self.state.pin();
        let owner_id = self.state.owner_id();
        let trust = build_trust(
            directory,
            (&owner_id, &pin_sign, &pin_box),
            self.state.number("revocationVersion"),
            now_ms(),
        )?;
        let Some(me) = trust.agent(&self.state.agent_id()) else {
            return Err(Error::policy(
                "not_certified",
                "this agent has no valid owner certificate (revoked or expired)",
            ));
        };
        let mut changed = false;
        // the name is a nickname the owner can change: follow the owner's current cert
        if me.name != self.state.name() && valid_name(&me.name) {
            self.state.set("name", Value::Str(me.name.clone()));
            changed = true;
        }
        if trust.owner.sign_pub != pin_sign {
            let pin = Obj::new()
                .with("signPub", &trust.owner.sign_pub)
                .with("boxPub", &trust.owner.box_pub);
            self.state.set("ownerPin", Value::Obj(pin));
            changed = true;
        }
        if trust.revocation_version > self.state.number("revocationVersion") {
            self.state
                .set("revocationVersion", Value::Num(trust.revocation_version));
            changed = true;
        }
        if changed {
            self.save()?;
        }
        let trust = Rc::new(trust);
        self.cached_trust = Some(trust.clone());
        self.cached_version = version;
        Ok(trust)
    }

    /// "owner", an agent name, or an agent id → id
    pub fn resolve(&mut self, target: &str) -> Result<String, Error> {
        let trust = self.trust(TrustOpts::default())?;
        if target == "owner" || target == trust.owner_id {
            return Ok(trust.owner_id.clone());
        }
        if trust.agent(target).is_some() {
            return Ok(target.into());
        }
        if let Some(c) = trust.agents.iter().find(|c| c.name == target) {
            return Ok(c.agent_id.clone());
        }
        Err(Error::policy(
            "unknown_party",
            format!("no certified agent named {target}"),
        ))
    }

    fn next_seq(&mut self) -> Result<f64, Error> {
        let seq = self.state.number("seq") + 1.0;
        self.state.set("seq", Value::Num(seq));
        self.save()?;
        Ok(seq)
    }

    pub fn send(
        &mut self,
        kind: &str,
        to: &str,
        body: &Value,
        opts: SendOpts,
    ) -> Result<Sent, Error> {
        let trust = self.trust(TrustOpts::default())?;
        let to_id = self.resolve(to)?;
        let me = self.state.agent_id();
        let mut scope = None;
        let mut grant_id = None;
        let agent_to_agent = to_id != trust.owner_id;
        if agent_to_agent && kind == "message" {
            let s = opts.scope.clone().unwrap_or_else(|| "message".into());
            let Some(grant) = trust.find_grant(&me, &to_id, &s) else {
                let name = self.state.name();
                let peer = trust.name_of(&to_id);
                return Err(Error::policy(
                    "no_grant",
                    format!(
                        "no grant lets {name} send \"{s}\" to {peer} — ask the owner: catcher grant {name} {peer} {s}"
                    ),
                ));
            };
            grant_id = Some(grant.grant_id.clone());
            scope = Some(s);
        }
        if agent_to_agent && kind == "reply" {
            let Some(g) = &opts.grant_id else {
                return Err(Error::policy(
                    "no_grant",
                    "a reply to another agent needs the grant of its message",
                ));
            };
            grant_id = Some(g.clone());
        }
        let id = opts
            .id
            .clone()
            .unwrap_or_else(|| random_id('m', &mut random_bytes));
        let mut parties: Vec<String> = Vec::new();
        for p in [&to_id, &trust.owner_id, &me] {
            if !parties.contains(p) {
                parties.push(p.clone());
            }
        }
        let mut recipients = Vec::new();
        for p in &parties {
            recipients.push((p.clone(), trust.box_key_of(p)?.to_string()));
        }
        let post = |client: &mut Self, seq: f64| -> Result<Value, Error> {
            let envelope = seal_envelope(
                SealInput {
                    id: id.clone(),
                    owner_id: trust.owner_id.clone(),
                    from: me.clone(),
                    to: to_id.clone(),
                    kind: kind.into(),
                    seq,
                    body,
                    reference: opts.reference.clone(),
                    scope: scope.clone(),
                    grant_id: grant_id.clone(),
                    expires_at: None,
                    created_at: now_ms(),
                    sender: &client.identity,
                    recipients: recipients.clone(),
                },
                &mut random_bytes,
            )?;
            let req = Value::Obj(Obj::new().with("envelope", envelope));
            client.api.call("POST", "/v1/envelopes", Some(&req), true)
        };
        let seq = self.next_seq()?;
        let res = match post(self, seq) {
            Ok(r) => r,
            Err(e) if e.api_code() == Some("stale_seq") => {
                // state file was restored or copied: resume from the relay's counter, never moving it back
                let me = self.me()?;
                let last = json::to_number(me.get("lastSeq"));
                let cur = self.state.number("seq");
                let max = if cur.is_nan() || last.is_nan() {
                    f64::NAN
                } else {
                    cur.max(last)
                };
                self.state.set("seq", Value::Num(max));
                let seq = self.next_seq()?;
                post(self, seq)?
            }
            Err(e) => return Err(e),
        };
        Ok(Sent {
            id,
            held: res.get("held").cloned(),
            duplicate: res.get("duplicate").cloned(),
        })
    }

    /// Verify + decrypt. Anything that fails policy comes back in `rejected` and is never shown as content.
    pub fn verify_all(
        &mut self,
        rows: &[Value],
        known_version: Option<Value>,
    ) -> Result<(Vec<Received>, Vec<Rejected>), Error> {
        let mut trust = self.trust(TrustOpts {
            refresh: false,
            known_version,
        })?;
        let mut received = Vec::new();
        let mut rejected = Vec::new();
        let me = self.state.agent_id();
        for row in rows {
            let env = row.get("envelope").cloned().unwrap_or(Value::Null);
            let core = env
                .get("core")
                .cloned()
                .ok_or("Cannot read properties of undefined (reading 'core')")?;
            let c = |k: &str| core.get(k).cloned();
            // set when a step fails for a reason that is not this message's fault (the relay unreachable): the whole
            // pass stops and nothing is rejected or acked, so the message comes again
            let mut abort: Option<Error> = None;
            let outcome = (|| -> Result<Received, Error> {
                check_fields(&core)?;
                if !is(core.get("to"), &me) {
                    return Err(Error::policy("not_mine", "not addressed to this agent"));
                }
                if let Some(Value::Str(id)) = core.get("id")
                    && self.seen.contains(id)
                {
                    return Err(Error::policy("replay", "already received this message"));
                }
                let kind = core.get("type");
                if is(kind, "reply") || is(kind, "answer") {
                    let k = to_js_string(kind);
                    let reference = match core.get("ref") {
                        None | Some(Value::Null) => String::new(),
                        Some(v) => to_js_string(Some(v)),
                    };
                    if let Some(outgoing) = &self.outgoing {
                        let sent = outgoing.get(&reference);
                        if sent.is_none_or(|s| !strict_eq(s.1.as_ref(), core.get("from"))) {
                            return Err(Error::policy(
                                "bad_ref",
                                format!(
                                    "{k} does not answer a message this agent sent to {}",
                                    to_js_string(core.get("from"))
                                ),
                            ));
                        }
                        let sent_type = sent.and_then(|s| s.0.as_ref());
                        if k == "answer" && !OWNER_REQUEST_TYPES.iter().any(|t| is(sent_type, t)) {
                            return Err(Error::policy(
                                "bad_ref",
                                "answer to something that was not a request",
                            ));
                        }
                        if k == "reply" && !is(sent_type, "message") {
                            return Err(Error::policy("bad_ref", "reply to a non-message"));
                        }
                    }
                }
                let release = row.get("release");
                if let Err(e) = check_envelope(&trust, &env, release, now_ms()) {
                    // a sender certified after our last directory read: refresh once
                    if e.policy_code() != Some("unknown_party") {
                        return Err(e);
                    }
                    match self.trust(TrustOpts {
                        refresh: true,
                        known_version: None,
                    }) {
                        Ok(t) => trust = t,
                        Err(e) => {
                            abort = Some(e);
                            return Err(Error::plain("directory refresh failed"));
                        }
                    }
                    check_envelope(&trust, &env, release, now_ms())?;
                }
                let body = open_envelope(&env, &me, &self.identity)?;
                let grant = match core.get("grantId") {
                    Some(Value::Str(g)) if !is(core.get("from"), &trust.owner_id) => Some((
                        g.clone(),
                        trust.grant(g).is_some_and(|g| g.require_approval),
                    )),
                    _ => None,
                };
                Ok(Received {
                    id: c("id"),
                    cursor: row.get("cursor").cloned(),
                    kind: c("type"),
                    from_id: c("from"),
                    from_name: trust.name_of(&to_js_string(core.get("from"))),
                    to: c("to"),
                    reference: c("ref"),
                    scope: c("scope"),
                    grant_id: c("grantId"),
                    created_at: c("createdAt"),
                    expires_at: c("expiresAt"),
                    received_at: row.get("receivedAt").cloned(),
                    grant,
                    body,
                })
            })();
            if let Some(e) = abort {
                return Err(e);
            }
            match outcome {
                Ok(r) => received.push(r),
                Err(e) => rejected.push(Rejected {
                    id: c("id"),
                    cursor: row.get("cursor").cloned(),
                    from: c("from"),
                    reason: e.message().to_string(),
                    code: e.policy_code().unwrap_or("bad_envelope").to_string(),
                }),
            }
        }
        Ok((received, rejected))
    }

    /// Replies and answers are checked against this; a long-running watch refreshes it from history.
    pub fn set_outgoing(&mut self, outgoing: Outgoing) {
        self.outgoing = Some(outgoing);
    }

    /// One page of unacked messages after `after` (cursor). Rows whose id is in `skip` (already handed out in this
    /// run) are not verified again.
    pub fn inbox_page(
        &mut self,
        limit: f64,
        after: f64,
        skip: &HashSet<String>,
    ) -> Result<InboxPage, Error> {
        let res = self.api.call(
            "GET",
            &format!(
                "/v1/inbox?limit={}&after={}",
                number_to_string(limit),
                number_to_string(after)
            ),
            None,
            true,
        )?;
        let all = res
            .get("envelopes")
            .and_then(Value::as_arr)
            .cloned()
            .unwrap_or_default();
        let full = all.len() as f64 >= limit;
        let last = all
            .iter()
            .filter_map(|r| r.num("cursor"))
            .fold(after, f64::max);
        let rows: Vec<Value> = all
            .into_iter()
            .filter(|r| {
                let id = r
                    .get("envelope")
                    .and_then(|e| e.get("core"))
                    .and_then(|c| c.str("id"));
                !id.is_some_and(|id| skip.contains(id))
            })
            .collect();
        let dir_version = res.get("dirVersion").cloned();
        let (received, rejected) = self.inbox_verify(rows, dir_version)?;
        Ok(InboxPage {
            received,
            rejected,
            last_cursor: last,
            full,
        })
    }

    fn inbox_verify(
        &mut self,
        rows: Vec<Value>,
        dir_version: Option<Value>,
    ) -> Result<(Vec<Received>, Vec<Rejected>), Error> {
        if rows.is_empty() {
            // nothing to verify, but still notice directory changes (this agent revoked, owner key rotated)
            let cached = self.profile.load_directory();
            let cached_version = cached.as_ref().and_then(|c| c.get("version"));
            if !strict_eq(dir_version.as_ref(), cached_version) {
                self.trust(TrustOpts {
                    refresh: false,
                    known_version: dir_version,
                })?;
            }
            return Ok((Vec::new(), Vec::new()));
        }
        self.verify_all(&rows, dir_version)
    }

    pub fn ack(&self, ids: &[Value]) -> Result<Value, Error> {
        if ids.is_empty() {
            return Ok(Value::Num(0.0));
        }
        let body = Value::Obj(Obj::new().with("ids", Value::Arr(ids.to_vec())));
        let res = self.api.call("POST", "/v1/ack", Some(&body), true)?;
        Ok(res.get("acked").cloned().unwrap_or(Value::Null))
    }

    /// Answers/replies to one of this agent's requests.
    pub fn replies(&mut self, reference: &str) -> Result<Vec<Received>, Error> {
        let res = self.api.call(
            "GET",
            &format!("/v1/replies?ref={}", encode_uri_component(reference)),
            None,
            true,
        )?;
        let rows = res
            .get("envelopes")
            .and_then(Value::as_arr)
            .cloned()
            .unwrap_or_default();
        let (received, _) = self.verify_all(&rows, None)?;
        let me = self.state.agent_id();
        Ok(received
            .into_iter()
            .filter(|r| is(r.reference.as_ref(), reference) && is(r.to.as_ref(), &me))
            .collect())
    }

    /// Poll for the first answer/reply to `reference` whose id is not in `skip` (ones already looked at). None on
    /// timeout.
    pub fn wait_for(
        &mut self,
        reference: &str,
        timeout_ms: f64,
        skip: &HashSet<String>,
    ) -> Result<Option<Received>, Error> {
        let deadline = now_ms() + timeout_ms;
        let mut interval: f64 = 2000.0;
        loop {
            let fresh = self
                .replies(reference)?
                .into_iter()
                .find(|r| !skip.contains(&r.id_str()));
            if let Some(first) = fresh {
                return Ok(Some(first));
            }
            if now_ms() >= deadline {
                return Ok(None);
            }
            let wait = interval.min((deadline - now_ms()).max(0.0));
            std::thread::sleep(Duration::from_millis(wait as u64));
            // back off gently: 2s → 15s
            interval = (interval * 1.5).round().min(15000.0);
        }
    }
}

pub fn is_envelope_id(s: &str) -> bool {
    s.len() == 28
        && s.starts_with("m_")
        && s[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

fn is_grant_id(s: &str) -> bool {
    s.len() == 18
        && s.starts_with("g_")
        && s[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

/// `^[a-z0-9][a-z0-9._:-]{0,63}$`
fn is_scope(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._:-".contains(c))
}

fn is_safe_integer(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Num(n)) if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

/// The fields the channel line shows as verified must have the shape the protocol gives them: the signature covers
/// them, but a sender could still sign odd values.
fn check_fields(core: &Value) -> Result<(), Error> {
    let bad = |what: &str| {
        Err(Error::policy(
            "bad_fields",
            format!("envelope has a bad {what}"),
        ))
    };
    if !core.str("id").is_some_and(is_envelope_id) {
        return bad("id");
    }
    if core.str("from").is_none() || core.str("to").is_none() {
        return bad("sender or recipient");
    }
    let kind = core.get("type");
    match (is(kind, "message"), core.get("ref")) {
        (true, Some(Value::Null)) => {}
        (false, Some(Value::Str(r))) if is_envelope_id(r) => {}
        _ => return bad("ref"),
    }
    match core.get("scope") {
        Some(Value::Null) => {}
        Some(Value::Str(sc)) if is_scope(sc) => {}
        _ => return bad("scope"),
    }
    match core.get("grantId") {
        Some(Value::Null) => {}
        Some(Value::Str(g)) if is_grant_id(g) => {}
        _ => return bad("grant id"),
    }
    if !is_safe_integer(core.get("createdAt")) {
        return bad("createdAt");
    }
    if !(matches!(core.get("expiresAt"), Some(Value::Null))
        || is_safe_integer(core.get("expiresAt")))
    {
        return bad("expiresAt");
    }
    Ok(())
}

/// `encodeURIComponent`
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
