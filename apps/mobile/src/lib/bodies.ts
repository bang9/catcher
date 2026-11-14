// Bodies come from agents: verified means "this agent sent it", not "it has the right shape".
// Every screen reads bodies through these guards and renders the result as plain text.

import type { AnswerBody, AskBody, ConfirmBody, GrantRequestBody, MessageBody, OtpBody } from '@catcher/protocol';

type Obj = Record<string, unknown>;

function obj(body: unknown): Obj | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Obj;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  return undefined;
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

export function asMessage(body: unknown): MessageBody | null {
  const o = obj(body);
  if (!o) return null;
  return { text: str(o.text), data: o.data as MessageBody['data'] };
}

/** One line of plain text for a message body: its text, or its data as JSON. */
export function messageText(body: unknown): string {
  const m = asMessage(body);
  if (!m) return '';
  if (m.text) return m.text;
  if (m.data !== undefined) return JSON.stringify(m.data, null, 2);
  return '';
}

export function asAsk(body: unknown): AskBody | null {
  const o = obj(body);
  const question = str(o?.question);
  if (!o || question === undefined) return null;
  return { question, choices: strings(o.choices) };
}

export function asConfirm(body: unknown): ConfirmBody | null {
  const o = obj(body);
  const action = str(o?.action);
  if (!o || action === undefined) return null;
  return { action, details: str(o.details) };
}

export function asOtp(body: unknown): OtpBody | null {
  const o = obj(body);
  const service = str(o?.service);
  if (!o || service === undefined) return null;
  return { service, hint: str(o.hint) };
}

export function asGrantRequest(body: unknown): GrantRequestBody | null {
  const o = obj(body);
  if (!o) return null;
  if (o.action === 'grant') {
    const from = str(o.from);
    const to = str(o.to);
    if (!from || !to) return null;
    let expiresInSec: number | null = null;
    if (typeof o.expiresInSec === 'number') expiresInSec = o.expiresInSec;
    return {
      action: 'grant',
      from,
      to,
      scopes: strings(o.scopes),
      requireApproval: o.requireApproval === true,
      expiresInSec,
      note: str(o.note),
    };
  }
  if (o.action === 'revoke')
    return { action: 'revoke', grantId: str(o.grantId), agentId: str(o.agentId), note: str(o.note) };
  return null;
}

export function asAnswer(body: unknown): AnswerBody | null {
  const o = obj(body);
  if (!o) return null;
  let approved: boolean | undefined;
  if (typeof o.approved === 'boolean') approved = o.approved;
  return { answer: str(o.answer), approved, code: str(o.code), note: str(o.note) };
}
