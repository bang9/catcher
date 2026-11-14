-- catcher relay storage. Content is ciphertext only; statements are owner-signed JSON the server cannot forge.
-- The relay is a mailbox: history lives on the agents (~/.catcher) and the owner's phone, delivered envelopes are deleted.

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  sign_pub TEXT NOT NULL,
  box_pub TEXT NOT NULL,
  chain TEXT NOT NULL,                 -- JSON Signed<OwnerKeyPayload>[]
  revocations TEXT,                    -- JSON Signed<RevocationsPayload>
  revocation_version INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  dir_version INTEGER NOT NULL DEFAULT 1,  -- bumps on any cert/grant/revocation/key change; agents cache the directory by it
  feed_cursor INTEGER NOT NULL DEFAULT 0,  -- how far the owner app has synced; delivered envelopes behind it are deleted
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX owners_sign_pub ON owners(sign_pub);

CREATE TABLE push_tokens (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  locale TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX push_tokens_owner ON push_tokens(owner_id);

CREATE TABLE pairings (
  code TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sign_pub TEXT NOT NULL UNIQUE,
  box_pub TEXT NOT NULL,
  device TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,                -- pending | active | rejected | revoked
  cert TEXT,                           -- JSON Signed<CertPayload>
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX agents_owner ON agents(owner_id, status);
CREATE UNIQUE INDEX agents_owner_name ON agents(owner_id, name) WHERE status IN ('pending', 'active');

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  statement TEXT NOT NULL,             -- JSON Signed<GrantPayload>
  scopes TEXT NOT NULL,                -- JSON string[] (copy for the pre-filter; agents verify the signed statement)
  require_approval INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX grants_owner ON grants(owner_id, revoked);
CREATE INDEX grants_pair ON grants(from_id, to_id, revoked);

CREATE TABLE envelopes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ref TEXT,
  envelope TEXT NOT NULL,              -- JSON Envelope (ciphertext)
  held INTEGER NOT NULL DEFAULT 0,
  release TEXT,                        -- JSON Signed<ReleasePayload>
  acked_at INTEGER,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX envelopes_inbox ON envelopes(to_id, acked_at, held, cursor);
CREATE INDEX envelopes_owner ON envelopes(owner_id, cursor);
CREATE INDEX envelopes_from ON envelopes(from_id, cursor);
CREATE INDEX envelopes_ref ON envelopes(ref);
CREATE INDEX envelopes_expiry ON envelopes(expires_at);
