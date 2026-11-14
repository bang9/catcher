// Local history. The relay deletes envelopes once they are delivered and synced to this phone, so this
// database is the owner's only long-term copy. Holds decrypted bodies; never holds the owner key.

import * as SQLite from 'expo-sqlite';
import type { Envelope } from '@catcher/protocol';
import type { OwnerItem } from '@catcher/client';

export type LocalItem = OwnerItem & { dropped: boolean };

const db = SQLite.openDatabaseSync('catcher.db');

db.execSync(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY NOT NULL,
  cursor INTEGER NOT NULL,
  type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  ref TEXT,
  scope TEXT,
  grant_id TEXT,
  created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER,
  held INTEGER NOT NULL,
  released INTEGER NOT NULL,
  acked INTEGER NOT NULL,
  dropped INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL,
  problem TEXT,
  body TEXT,
  envelope TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_cursor ON items (cursor);
CREATE INDEX IF NOT EXISTS items_held ON items (held);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`);

interface ItemRow {
  id: string;
  cursor: number;
  type: string;
  from_id: string;
  to_id: string;
  ref: string | null;
  scope: string | null;
  grant_id: string | null;
  created_at: number;
  received_at: number;
  expires_at: number | null;
  held: number;
  released: number;
  acked: number;
  dropped: number;
  verified: number;
  problem: string | null;
  body: string | null;
  envelope: string;
}

export function getKv(key: string): string | null {
  const row = db.getFirstSync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
  return row?.value ?? null;
}

export function setKv(key: string, value: string): void {
  db.runSync(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export function deleteKv(key: string): void {
  db.runSync('DELETE FROM kv WHERE key = ?', key);
}

export function getCursor(): number {
  return Number(getKv('cursor') ?? '0') || 0;
}

function bodyText(item: OwnerItem): string | null {
  if (!item.verified) return null;
  return JSON.stringify(item.body ?? null);
}

/**
 * Store one feed page and move the cursor in one transaction, so the cursor never runs ahead of what is on disk
 * (the next feed call tells the relay it may delete everything up to it). A row that already verified keeps
 * its body: it is never re-opened with a newer key.
 */
export function savePage(items: OwnerItem[], cursor: number): void {
  db.withTransactionSync(() => {
    for (const i of items) {
      db.runSync(
        `INSERT INTO items (id, cursor, type, from_id, to_id, ref, scope, grant_id, created_at, received_at, expires_at,
           held, released, acked, verified, problem, body, envelope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cursor = excluded.cursor,
           held = CASE WHEN items.dropped = 1 THEN 0 ELSE excluded.held END,
           released = excluded.released,
           acked = excluded.acked,
           verified = MAX(items.verified, excluded.verified),
           problem = CASE WHEN items.verified = 1 THEN items.problem ELSE excluded.problem END,
           body = CASE WHEN items.verified = 1 THEN items.body ELSE excluded.body END`,
        i.id,
        i.cursor,
        i.type,
        i.from,
        i.to,
        i.ref,
        i.scope,
        i.grantId,
        i.createdAt,
        i.receivedAt,
        i.expiresAt,
        Number(i.held),
        Number(i.released),
        Number(i.acked),
        Number(i.verified),
        i.problem,
        bodyText(i),
        JSON.stringify(i.envelope),
      );
    }
    setKv('cursor', String(cursor));
  });
}

/** Re-opened rows that failed before because the sender's certificate was missing. Only touches rows that never verified. */
export function saveReopened(items: OwnerItem[]): void {
  db.withTransactionSync(() => {
    for (const i of items) {
      if (!i.verified) continue;
      db.runSync(
        'UPDATE items SET verified = 1, problem = NULL, body = ? WHERE id = ? AND verified = 0',
        bodyText(i),
        i.id,
      );
    }
  });
}

export function unverifiedEnvelopes(limit = 200): { cursor: number; envelope: Envelope; held: boolean }[] {
  return db
    .getAllSync<Pick<ItemRow, 'cursor' | 'envelope' | 'held'>>(
      "SELECT cursor, envelope, held FROM items WHERE verified = 0 AND problem LIKE '%certificate%' ORDER BY cursor DESC LIMIT ?",
      limit,
    )
    .map((r) => ({ cursor: r.cursor, envelope: JSON.parse(r.envelope) as Envelope, held: r.held === 1 }));
}

export function heldIds(): string[] {
  return db.getAllSync<{ id: string }>('SELECT id FROM items WHERE held = 1').map((r) => r.id);
}

export function setHeldState(
  id: string,
  state: { held: boolean; released: boolean; dropped: boolean; acked: boolean },
) {
  db.runSync(
    'UPDATE items SET held = ?, released = ?, dropped = ?, acked = ? WHERE id = ?',
    Number(state.held),
    Number(state.released),
    Number(state.dropped),
    Number(state.acked),
    id,
  );
}

function parseBody(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function loadItems(names: (id: string) => string): LocalItem[] {
  const rows = db.getAllSync<ItemRow>('SELECT * FROM items ORDER BY cursor');
  return rows.map((r) => {
    const envelope = JSON.parse(r.envelope) as Envelope;
    return {
      id: r.id,
      cursor: r.cursor,
      type: envelope.core.type,
      from: r.from_id,
      to: r.to_id,
      fromName: names(r.from_id),
      toName: names(r.to_id),
      ref: r.ref,
      scope: r.scope,
      grantId: r.grant_id,
      createdAt: r.created_at,
      receivedAt: r.received_at,
      expiresAt: r.expires_at,
      held: r.held === 1,
      released: r.released === 1,
      acked: r.acked === 1,
      dropped: r.dropped === 1,
      body: parseBody(r.body),
      verified: r.verified === 1,
      problem: r.problem,
      envelope,
    };
  });
}

/** Another owner on this phone (restore with a different code): start the local history over. */
export function resetForOwner(ownerId: string): void {
  if (getKv('ownerId') === ownerId) return;
  db.withTransactionSync(() => {
    db.runSync('DELETE FROM items');
    db.runSync('DELETE FROM kv');
    setKv('ownerId', ownerId);
  });
}
