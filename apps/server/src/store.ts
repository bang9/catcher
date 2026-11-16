// D1 reads shared by handlers — directory (all owner-signed) and envelope rows.

import type {
  CertPayload,
  Directory,
  GrantPayload,
  OwnerKeyPayload,
  ReleasePayload,
  RevocationsPayload,
  Signed,
  StoredEnvelope,
} from '@catcher/protocol';
import type { Env } from './http.ts';

export interface OwnerRow {
  id: string;
  sign_pub: string;
  box_pub: string;
  chain: string;
  revocations: string | null;
  revocation_version: number;
  last_seq: number;
}

export interface AgentRow {
  id: string;
  owner_id: string;
  name: string;
  sign_pub: string;
  box_pub: string;
  device: string;
  provider: string;
  status: string;
  cert: string | null;
  created_at: number;
  last_seen_at: number | null;
  last_seq: number;
  removed_at: number | null;
}

export interface EnvelopeRow {
  cursor: number;
  id: string;
  owner_id: string;
  from_id: string;
  to_id: string;
  type: string;
  ref: string | null;
  envelope: string;
  held: number;
  release: string | null;
  acked_at: number | null;
  received_at: number;
}

/** JSON column that may be NULL */
export function parseOrNull<T>(text: string | null): T | null {
  if (!text) return null;
  return JSON.parse(text) as T;
}

export async function getOwner(env: Env, ownerId: string): Promise<OwnerRow> {
  const row = await env.DB.prepare('SELECT * FROM owners WHERE id = ?').bind(ownerId).first<OwnerRow>();
  if (!row) throw new Error(`owner ${ownerId} missing`);
  return row;
}

/** Directory for the owner (all grants) or for one agent (grants it is part of). */
export async function loadDirectory(env: Env, ownerId: string, forAgent?: string): Promise<Directory> {
  const owner = await getOwner(env, ownerId);
  const certs = await env.DB.prepare(
    "SELECT cert FROM agents WHERE owner_id = ? AND status = 'active' AND cert IS NOT NULL",
  )
    .bind(ownerId)
    .all<{ cert: string }>();
  let grantQuery = env.DB.prepare('SELECT statement FROM grants WHERE owner_id = ? AND revoked = 0').bind(ownerId);
  if (forAgent) {
    grantQuery = env.DB.prepare(
      'SELECT statement FROM grants WHERE owner_id = ? AND revoked = 0 AND (from_id = ? OR to_id = ?)',
    ).bind(ownerId, forAgent, forAgent);
  }
  const grants = await grantQuery.all<{ statement: string }>();
  return {
    ownerId,
    ownerChain: JSON.parse(owner.chain) as Signed<OwnerKeyPayload>[],
    revocations: parseOrNull<Signed<RevocationsPayload>>(owner.revocations),
    certs: certs.results.map((r) => JSON.parse(r.cert) as Signed<CertPayload>),
    grants: grants.results.map((r) => JSON.parse(r.statement) as Signed<GrantPayload>),
  };
}

export function toStored(row: EnvelopeRow): StoredEnvelope {
  return {
    cursor: row.cursor,
    envelope: JSON.parse(row.envelope),
    held: row.held === 1,
    release: parseOrNull<Signed<ReleasePayload>>(row.release),
    ackedAt: row.acked_at,
    receivedAt: row.received_at,
  };
}

export async function nameOf(env: Env, id: string, ownerId: string): Promise<string> {
  if (id === ownerId) return 'owner';
  const row = await env.DB.prepare('SELECT name FROM agents WHERE id = ?').bind(id).first<{ name: string }>();
  return row?.name ?? id;
}
