-- The owner can take a disconnected (revoked) agent off their lists. The row stays: its key stays taken, and old
-- history on the phone keeps its name.
ALTER TABLE agents ADD COLUMN removed_at INTEGER;
