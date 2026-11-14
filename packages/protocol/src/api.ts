// HTTP API shapes shared by the server, the CLI and the owner app. All paths are under /v1.

import type { Envelope } from './envelope.ts';
import type { Directory } from './policy.ts';
import type {
  CertPayload,
  GrantPayload,
  OwnerKeyPayload,
  PairingPayload,
  RegisterPayload,
  ReleasePayload,
  RevocationsPayload,
  Signed,
} from './statements.ts';

/** agent names; `owner` is reserved (see RESERVED_NAME) */
export const NAME_PATTERN = /^(?!owner$)[a-z0-9][a-z0-9-]{0,31}$/;
export const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export interface StoredEnvelope {
  /** server order — cursor for feeds */
  cursor: number;
  envelope: Envelope;
  held: boolean;
  release: Signed<ReleasePayload> | null;
  ackedAt: number | null;
  receivedAt: number;
}

export type AgentStatus = 'pending' | 'active' | 'rejected' | 'revoked';

export interface AgentSummary {
  agentId: string;
  name: string;
  device: string;
  provider: string;
  status: AgentStatus;
  signPub: string;
  boxPub: string;
  createdAt: number;
  lastSeenAt: number | null;
  cert: Signed<CertPayload> | null;
}

export interface ApiError {
  error: { code: string; message: string };
}

// — owner —
export interface CreateOwnerRequest {
  chain: Signed<OwnerKeyPayload>[];
}
export interface AppendOwnerKeyRequest {
  link: Signed<OwnerKeyPayload>;
}
export interface OwnerLookupResponse {
  ownerId: string;
  chain: Signed<OwnerKeyPayload>[];
}
export interface PushTokenRequest {
  token: string;
  platform: 'ios' | 'android' | 'web';
  locale: string;
}
export interface CreatePairingRequest {
  statement: Signed<PairingPayload>;
}
export interface CreatePairingResponse {
  code: string;
  expiresAt: number;
}
export interface FeedResponse {
  envelopes: StoredEnvelope[];
  cursor: number;
}
export interface AgentsResponse {
  agents: AgentSummary[];
  /** last seq the server accepted from each sender — the owner app compares with what it saw */
  senderSeq: Record<string, number>;
}
export interface PostCertRequest {
  cert: Signed<CertPayload>;
}
export interface PostGrantRequest {
  grant: Signed<GrantPayload>;
}
export interface PostRevocationsRequest {
  revocations: Signed<RevocationsPayload>;
}
export interface PostReleaseRequest {
  release: Signed<ReleasePayload>;
}

// — agent —
export interface RegisterRequest {
  statement: Signed<RegisterPayload>;
}
export interface RegisterResponse {
  agentId: string;
  ownerId: string;
  ownerChain: Signed<OwnerKeyPayload>[];
}
export interface MeResponse {
  agentId: string;
  ownerId: string;
  name: string;
  status: AgentStatus;
  cert: Signed<CertPayload> | null;
  /** highest seq the server accepted from this agent — resumes the counter after a lost state file */
  lastSeq: number;
}
export type DirectoryResponse = Directory;
export interface PostEnvelopeRequest {
  envelope: Envelope;
}
export interface PostEnvelopeResponse {
  cursor: number;
  held: boolean;
  duplicate: boolean;
}
export interface InboxResponse {
  envelopes: StoredEnvelope[];
}
export interface AckRequest {
  ids: string[];
}
export interface AckResponse {
  acked: number;
}
export interface RepliesResponse {
  envelopes: StoredEnvelope[];
}
export interface LogResponse {
  envelopes: StoredEnvelope[];
  cursor: number | null;
}
