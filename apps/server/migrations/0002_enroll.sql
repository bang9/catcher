-- 0.2: agent-first registration. The agent enrolls itself and shows its user a code; the owner's app claims it.
-- Pairing codes are gone, and so are pending/rejected agents (the old flow made them; nothing can approve them now).

DROP TABLE IF EXISTS pairings;
DELETE FROM agents WHERE status IN ('pending', 'rejected');

CREATE TABLE enrollments (
  lookup TEXT PRIMARY KEY,             -- first 5 characters of the agent's code; the rest never reaches the relay
  agent_id TEXT NOT NULL UNIQUE,
  sign_pub TEXT NOT NULL UNIQUE,
  statement TEXT NOT NULL,             -- JSON Signed<EnrollPayload>, self-signed by the agent
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,         -- unclaimed: code expiry; claimed: when the row may go (30 days, or 24 h
                                       -- after the agent's first authenticated call)
  claimed_by TEXT,
  claimed_at INTEGER,
  claim TEXT                           -- JSON Signed<ClaimPayload>, owner-signed
);
CREATE INDEX enrollments_expiry ON enrollments(expires_at);
