// Trust and policy: turns the relay's directory (all owner-signed) into a verified view, then decides whether one
// envelope may be accepted. The relay is not trusted for any of it.

use crate::envelope::verify_envelope;
use crate::error::Error;
use crate::json::{Value, is, nullish, strict_eq, to_js_string, to_number, truthy};
use crate::statements::{OwnerKeys, resolve_owner_keys, verify_statement};

/// No agent may be called this; it always means the owner.
pub const RESERVED_NAME: &str = "owner";

#[derive(Clone, Debug)]
pub struct Cert {
    pub agent_id: String,
    pub name: String,
    pub sign_pub: String,
    pub box_pub: String,
    pub payload: Value,
}

#[derive(Clone, Debug)]
pub struct Grant {
    pub grant_id: String,
    pub from: String,
    pub to: String,
    pub scopes: Vec<Value>,
    pub require_approval: bool,
}

impl Grant {
    pub fn covers(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s.is_str(scope))
    }
}

#[derive(Clone, Debug)]
pub struct Trust {
    pub owner_id: String,
    pub owner: OwnerKeys,
    pub revocation_version: f64,
    /// insertion-ordered like a JS Map
    pub agents: Vec<Cert>,
    pub grants: Vec<Grant>,
}

impl Trust {
    pub fn agent(&self, id: &str) -> Option<&Cert> {
        self.agents.iter().find(|c| c.agent_id == id)
    }

    pub fn grant(&self, id: &str) -> Option<&Grant> {
        self.grants.iter().find(|g| g.grant_id == id)
    }

    pub fn sign_key_of(&self, id: &str) -> Result<&str, Error> {
        if id == self.owner_id {
            return Ok(&self.owner.sign_pub);
        }
        self.agent(id)
            .map(|c| c.sign_pub.as_str())
            .ok_or_else(|| unknown_party(id))
    }

    pub fn box_key_of(&self, id: &str) -> Result<&str, Error> {
        if id == self.owner_id {
            return Ok(&self.owner.box_pub);
        }
        self.agent(id)
            .map(|c| c.box_pub.as_str())
            .ok_or_else(|| unknown_party(id))
    }

    /// A live grant that lets `from` send `scope` to `to`.
    pub fn find_grant(&self, from: &str, to: &str, scope: &str) -> Option<&Grant> {
        self.grants
            .iter()
            .find(|g| g.from == from && g.to == to && g.covers(scope))
    }

    /// "owner" for the owner, the cert name for agents, else the id
    pub fn name_of(&self, id: &str) -> String {
        if id == self.owner_id {
            return "owner".into();
        }
        self.agent(id)
            .map(|c| c.name.clone())
            .unwrap_or_else(|| id.to_string())
    }
}

fn unknown_party(id: &str) -> Error {
    Error::policy(
        "unknown_party",
        format!("{id} is not a certified agent (unknown, expired or revoked)"),
    )
}

fn upsert<T>(list: &mut Vec<T>, item: T, same: impl Fn(&T) -> bool) {
    match list.iter_mut().find(|x| same(x)) {
        Some(slot) => *slot = item,
        None => list.push(item),
    }
}

fn list(v: Option<&Value>, what: &str) -> Result<Vec<Value>, Error> {
    match v {
        Some(Value::Arr(a)) => Ok(a.clone()),
        _ => Err(Error::plain(format!("{what} is not iterable"))),
    }
}

/// Verify the whole directory against the pinned owner key. Anything not signed by the current owner key is
/// dropped. A revocation list older than one already seen is a rollback and fails hard.
pub fn build_trust(
    dir: &Value,
    pin: (&str, &str, &str),
    min_revocation_version: f64,
    now: f64,
) -> Result<Trust, Error> {
    let (owner_id, pin_sign, pin_box) = pin;
    if !is(dir.get("ownerId"), owner_id) {
        return Err(Error::policy(
            "owner_mismatch",
            "directory belongs to another owner",
        ));
    }
    let owner = resolve_owner_keys(
        dir.get("ownerChain").unwrap_or(&Value::Null),
        owner_id,
        pin_sign,
        pin_box,
    )?;
    let mut revocation_version = 0.0;
    let mut revoked_agents: Vec<Value> = Vec::new();
    let mut revoked_grants: Vec<Value> = Vec::new();
    if let Some(revs) = dir.get("revocations").filter(|v| truthy(Some(v))) {
        let r = verify_statement(revs, "revocations", &owner.sign_pub)?;
        if !is(r.get("ownerId"), owner_id) {
            return Err(Error::policy(
                "owner_mismatch",
                "revocation list belongs to another owner",
            ));
        }
        revocation_version = to_number(r.get("version"));
        revoked_agents = list(r.get("agents"), "r.agents")?;
        revoked_grants = list(r.get("grants"), "r.grants")?;
    }
    let revoked = |set: &[Value], id: Option<&Value>| set.iter().any(|x| strict_eq(Some(x), id));
    let mut agents: Vec<Cert> = Vec::new();
    let mut floor = min_revocation_version;
    for s in list(dir.get("certs"), "dir.certs")? {
        // not signed by the current owner key: ignore
        let Ok(c) = verify_statement(&s, "cert", &owner.sign_pub) else {
            continue;
        };
        if !is(c.get("ownerId"), owner_id) {
            continue;
        }
        // any genuine cert raises the floor, even one that is revoked or expired now
        if let Some(Value::Num(f)) = c.get("revocationFloor")
            && f.fract() == 0.0
            && f.abs() <= 9_007_199_254_740_991.0
            && *f > floor
        {
            floor = *f;
        }
        if to_number(c.get("expiresAt")) <= now
            || revoked(&revoked_agents, c.get("agentId"))
            || is(c.get("name"), RESERVED_NAME)
        {
            continue;
        }
        let (Some(agent_id), Some(name), Some(sign_pub), Some(box_pub)) = (
            c.str("agentId"),
            c.str("name"),
            c.str("signPub"),
            c.str("boxPub"),
        ) else {
            continue;
        };
        let cert = Cert {
            agent_id: agent_id.into(),
            name: name.into(),
            sign_pub: sign_pub.into(),
            box_pub: box_pub.into(),
            payload: c.clone(),
        };
        upsert(&mut agents, cert, |x| x.agent_id == agent_id);
    }
    if revocation_version < floor {
        return Err(Error::policy(
            "revocations_rolled_back",
            "server returned an older revocation list than this agent has seen",
        ));
    }
    let mut grants: Vec<Grant> = Vec::new();
    for s in list(dir.get("grants"), "dir.grants")? {
        let Ok(g) = verify_statement(&s, "grant", &owner.sign_pub) else {
            continue;
        };
        if !is(g.get("ownerId"), owner_id) || revoked(&revoked_grants, g.get("grantId")) {
            continue;
        }
        let expires = g.get("expiresAt");
        if !matches!(expires, Some(Value::Null)) && to_number(expires) <= now {
            continue;
        }
        let (Some(grant_id), Some(from), Some(to)) = (g.str("grantId"), g.str("from"), g.str("to"))
        else {
            continue;
        };
        if !agents.iter().any(|a| a.agent_id == from) || !agents.iter().any(|a| a.agent_id == to) {
            continue;
        }
        let grant = Grant {
            grant_id: grant_id.into(),
            from: from.into(),
            to: to.into(),
            scopes: g
                .get("scopes")
                .and_then(Value::as_arr)
                .cloned()
                .unwrap_or_default(),
            require_approval: truthy(g.get("requireApproval")),
        };
        upsert(&mut grants, grant, |x| x.grant_id == grant_id);
    }
    Ok(Trust {
        owner_id: owner_id.into(),
        owner,
        revocation_version,
        agents,
        grants,
    })
}

/// Decide whether `env` is acceptable: sender signature with the trusted key, then the grant rules.
/// `release` is the owner-signed release for envelopes under a requireApproval grant.
pub fn check_envelope(
    trust: &Trust,
    env: &Value,
    release: Option<&Value>,
    now: f64,
) -> Result<(), Error> {
    let core = env.get("core");
    let c = |k: &str| core.and_then(|c| c.get(k));
    if !is(c("ownerId"), &trust.owner_id) {
        return Err(Error::policy(
            "owner_mismatch",
            "envelope belongs to another owner",
        ));
    }
    let from = to_js_string(c("from"));
    let to = to_js_string(c("to"));
    let sender_key = trust.sign_key_of(&from)?.to_string();
    trust.sign_key_of(&to)?;
    verify_envelope(env, &sender_key).map_err(|e| Error::policy("bad_envelope", e))?;
    let expires = c("expiresAt");
    if !matches!(expires, Some(Value::Null)) && to_number(expires) <= now {
        return Err(Error::policy("expired", "envelope has expired"));
    }
    let kind = c("type").and_then(Value::as_str).unwrap_or_default();
    let agent_to_agent = from != trust.owner_id && to != trust.owner_id;
    if !agent_to_agent {
        if from == trust.owner_id && kind != "message" && kind != "answer" {
            return Err(Error::policy(
                "bad_type",
                format!("owner does not send {kind}"),
            ));
        }
        return Ok(());
    }
    let grant = || -> Option<&Grant> {
        if !truthy(c("grantId")) {
            return None;
        }
        trust.grant(c("grantId").and_then(Value::as_str)?)
    };
    if kind == "message" {
        let Some(g) = grant() else {
            return Err(Error::policy(
                "no_grant",
                "no live grant for this message (missing, expired or revoked)",
            ));
        };
        let scope = c("scope");
        if g.from != from
            || g.to != to
            || !truthy(scope)
            || !scope.and_then(Value::as_str).is_some_and(|s| g.covers(s))
        {
            let shown = if nullish(scope) {
                "?".to_string()
            } else {
                to_js_string(scope)
            };
            return Err(Error::policy(
                "no_grant",
                format!(
                    "grant {} does not cover {from} → {to} for {shown}",
                    g.grant_id
                ),
            ));
        }
        if g.require_approval {
            require_release(trust, env, release)?;
        }
        return Ok(());
    }
    if kind == "reply" {
        // must name a live grant linking the two agents; held exactly like messages under that grant
        let g = grant();
        let links =
            g.is_some_and(|g| (g.from == to && g.to == from) || (g.from == from && g.to == to));
        let Some(g) = g.filter(|_| links) else {
            return Err(Error::policy(
                "no_grant",
                "reply between agents with no live grant",
            ));
        };
        if g.require_approval {
            require_release(trust, env, release)?;
        }
        return Ok(());
    }
    Err(Error::policy(
        "bad_type",
        format!("agents do not send {kind} to each other"),
    ))
}

fn require_release(trust: &Trust, env: &Value, release: Option<&Value>) -> Result<(), Error> {
    let Some(release) = release.filter(|r| truthy(Some(r))) else {
        return Err(Error::policy(
            "held",
            "waiting for the owner to approve this message",
        ));
    };
    let r = verify_statement(release, "release", &trust.owner.sign_pub)?;
    let core = env.get("core");
    if !strict_eq(r.get("envelopeId"), core.and_then(|c| c.get("id")))
        || !strict_eq(r.get("ctHash"), env.get("ctHash"))
        || !is(r.get("ownerId"), &trust.owner_id)
    {
        return Err(Error::policy(
            "bad_release",
            "owner approval does not match this message",
        ));
    }
    Ok(())
}
