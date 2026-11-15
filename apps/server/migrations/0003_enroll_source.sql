-- Where a registration came from (client IPv4 address, or the /64 of an IPv6 address): one source may hold only a few
-- waiting codes, so nobody can fill the relay-wide cap alone.
ALTER TABLE enrollments ADD COLUMN source TEXT NOT NULL DEFAULT '';
CREATE INDEX enrollments_source ON enrollments(source, expires_at);
