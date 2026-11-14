// Push to the owner's phones through the Expo push service.
// Request/response shape: https://docs.expo.dev/push-notifications/sending-notifications/ (POST /--/api/v2/push/send,
// array of messages; answer {data: [{status: "ok", id} | {status: "error", message, details: {error}}]}).
// Content stays end-to-end encrypted, so a notification carries only metadata the server already has (names, type).

import type { Env } from './http.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export type PushKind =
  | { kind: 'registration'; agentName: string; provider: string; device: string }
  | { kind: 'envelope'; type: string; fromName: string; envelopeId: string }
  | { kind: 'held'; fromName: string; toName: string; envelopeId: string };

const TEXT = {
  ko: {
    registration: (p: Extract<PushKind, { kind: 'registration' }>) => ({
      title: '새 에이전트 등록 요청',
      body: `${p.agentName} (${p.provider} · ${p.device}) — 지문을 확인하고 승인해 주세요`,
    }),
    envelope: (p: Extract<PushKind, { kind: 'envelope' }>) => {
      const titles: Record<string, string> = {
        ask: `${p.fromName}이(가) 질문했어요`,
        confirm: `${p.fromName}이(가) 확인을 요청했어요`,
        otp: `${p.fromName}이(가) 인증번호를 기다려요`,
        'grant-request': `${p.fromName}이(가) 권한을 요청했어요`,
      };
      return { title: titles[p.type] ?? `${p.fromName}의 메시지`, body: '앱에서 열어 확인해 주세요' };
    },
    held: (p: Extract<PushKind, { kind: 'held' }>) => ({
      title: '메시지 승인이 필요해요',
      body: `${p.fromName} → ${p.toName}`,
    }),
  },
  en: {
    registration: (p: Extract<PushKind, { kind: 'registration' }>) => ({
      title: 'New agent wants to register',
      body: `${p.agentName} (${p.provider} · ${p.device}) — check the fingerprint and approve`,
    }),
    envelope: (p: Extract<PushKind, { kind: 'envelope' }>) => {
      const titles: Record<string, string> = {
        ask: `${p.fromName} asked a question`,
        confirm: `${p.fromName} needs your confirmation`,
        otp: `${p.fromName} is waiting for a code`,
        'grant-request': `${p.fromName} requested access`,
      };
      return { title: titles[p.type] ?? `Message from ${p.fromName}`, body: 'Open catcher to see it' };
    },
    held: (p: Extract<PushKind, { kind: 'held' }>) => ({
      title: 'A message needs your approval',
      body: `${p.fromName} → ${p.toName}`,
    }),
  },
};

function render(locale: string, p: PushKind): { title: string; body: string } {
  let t = TEXT.en;
  if (locale.toLowerCase().startsWith('ko')) t = TEXT.ko;
  switch (p.kind) {
    case 'registration':
      return t.registration(p);
    case 'envelope':
      return t.envelope(p);
    case 'held':
      return t.held(p);
  }
}

function pushData(p: PushKind): { kind: string; envelopeId: string | null; type: string | null } {
  if (p.kind === 'envelope') return { kind: p.kind, envelopeId: p.envelopeId, type: p.type };
  if (p.kind === 'held') return { kind: p.kind, envelopeId: p.envelopeId, type: 'message' };
  return { kind: p.kind, envelopeId: null, type: null };
}

export async function pushOwner(env: Env, ownerId: string, p: PushKind): Promise<void> {
  const { results } = await env.DB.prepare('SELECT token, locale FROM push_tokens WHERE owner_id = ?')
    .bind(ownerId)
    .all<{ token: string; locale: string }>();
  if (!results.length) return;
  const messages = results.map((r) => ({
    to: r.token,
    ...render(r.locale, p),
    sound: 'default',
    priority: 'high',
    data: pushData(p),
  }));
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (env.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  try {
    const res = await fetch(env.PUSH_URL || EXPO_PUSH_URL, { method: 'POST', headers, body: JSON.stringify(messages) });
    if (!res.ok) {
      console.warn('push failed', res.status, await res.text());
      return;
    }
    const answer = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
    const dead: string[] = [];
    (answer.data ?? []).forEach((d, i) => {
      const token = results[i]?.token;
      if (token && d.status === 'error' && d.details?.error === 'DeviceNotRegistered') dead.push(token);
    });
    for (const token of dead) await env.DB.prepare('DELETE FROM push_tokens WHERE token = ?').bind(token).run();
  } catch (e) {
    console.warn('push error', e);
  }
}
