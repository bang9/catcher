// Fixes from the 0.2 security review: link origin, lookup tombstones, per-source limits, the replace re-check,
// verified-field shapes on the channel, delivery before ack, lock and poll races, revocation rollback on the owner,
// transient errors during a directory refresh, late claims and the agent-side claim window.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { EnrollmentError, type OwnerClient, RollbackError } from '@catcher/client';
import {
  agentIdFor,
  AUTH_HEADER,
  b64,
  ENROLL_TTL_MS,
  type EnrollPayload,
  enrollParts,
  type Envelope,
  type Identity,
  identityFromSeed,
  newIdentity,
  randomBytes,
  randomId,
  sealEnvelope,
  type Signed,
  signEnroll,
  signRequest,
  unb64,
} from '@catcher/protocol';
import { cli, cliCommand, cliEnv, enrollAgent, newOwner, nextIp, type Relay, startRelay } from './harness.ts';

let relay: Relay;

before(async () => {
  relay = await startRelay();
});

after(() => relay?.stop());

const profileDir = (home: string) => join(relay.work, home, 'profiles', 'default');
const pendingOf = (home: string) => JSON.parse(readFileSync(join(profileDir(home), 'pending.json'), 'utf8'));
const identityOf = (home: string): Identity => identityFromSeed(unb64(pendingOf(home).seed));
const lookupOf = (code: string) => code.replace(/-/g, '').slice(0, 5);

function statement(agent: Identity, over: Partial<EnrollPayload> = {}): Signed<EnrollPayload> {
  return signEnroll(
    {
      lookup: over.lookup ?? enrollParts(randomBytes(10)).lookup,
      name: over.name ?? 'raw',
      device: over.device ?? 'test',
      provider: over.provider ?? 'test',
      issuedAt: over.issuedAt ?? Date.now(),
    },
    agent,
  );
}

async function postEnroll(s: Signed<EnrollPayload>, ip = nextIp()): Promise<{ status: number; data: any }> {
  const r = await fetch(`${relay.direct}/v1/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ statement: s }),
  });
  return { status: r.status, data: await r.json() };
}

async function register(home: string, name = home): Promise<any> {
  const r = await cli(relay, home, ['register', '--name', name, '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  return r.json;
}

/** An inbox row as the relay stores it, for a tampering relay to slip in. */
function row(envelope: Envelope, cursor: number) {
  return { cursor, envelope, held: false, release: null, ackedAt: null, receivedAt: Date.now() };
}

function ownerEnvelope(owner: OwnerClient, to: { agentId: string; boxPub: string }, over: Record<string, unknown>) {
  return sealEnvelope({
    id: randomId('m'),
    ownerId: owner.state.ownerId,
    from: owner.state.ownerId,
    to: to.agentId,
    type: 'message',
    seq: owner.state.seq + 1000,
    body: { text: 'crafted' },
    sender: owner.identity,
    recipients: [
      { id: to.agentId, boxPub: to.boxPub },
      { id: owner.state.ownerId, boxPub: b64(owner.identity.boxPub) },
    ],
    ...over,
  } as Parameters<typeof sealEnvelope>[0]);
}

// ─── 2. tombstones ───────────────────────────────────────────────────────────

test('an expired lookup stays reserved for its own key for a day', async () => {
  const a = newIdentity();
  const first = statement(a);
  const lookup = first.payload.lookup;
  assert.equal((await postEnroll(first)).status, 201);
  relay.sql(`UPDATE enrollments SET expires_at = ${Date.now() - 1000} WHERE lookup = '${lookup}'`);
  // someone else's key (say, one ground to the same 25-bit tag) under the expired lookup
  const other = await postEnroll(statement(newIdentity(), { lookup }));
  assert.equal(other.status, 409);
  assert.equal(other.data.error.code, 'lookup_taken');
  // the hourly run keeps the tombstone
  await relay.scheduled();
  assert.equal(relay.sql(`SELECT lookup FROM enrollments WHERE lookup = '${lookup}'`).length, 1);
  // the same key may register again under it
  assert.equal((await postEnroll(statement(a, { lookup }))).status, 201);
  // a day after expiry the lookup is free
  relay.sql(`UPDATE enrollments SET expires_at = ${Date.now() - 25 * 3_600_000} WHERE lookup = '${lookup}'`);
  await relay.scheduled();
  assert.equal(relay.sql(`SELECT lookup FROM enrollments WHERE lookup = '${lookup}'`).length, 0);
  assert.equal((await postEnroll(statement(newIdentity(), { lookup }))).status, 201);
});

// ─── 3. sources ──────────────────────────────────────────────────────────────

test('enroll limits count an IPv6 /64 as one source', async () => {
  const spellings = ['2001:db8:a:b::1', '2001:DB8:A:B:0:0:0:2', '2001:db8:a:b:ffff::3', '2001:0db8:000a:000b::4'];
  const statuses: number[] = [];
  for (const ip of [...spellings, '2001:db8:a:b::5', '2001:db8:a:b:1:2:3:4']) {
    statuses.push((await postEnroll(statement(newIdentity()), ip)).status);
  }
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
  // another /64 is another source
  assert.equal((await postEnroll(statement(newIdentity()), '2001:db8:a:c::1')).status, 201);
  const sources = relay.sql("SELECT DISTINCT source FROM enrollments WHERE source LIKE '2001:db8:a:%'");
  assert.deepEqual(sources.map((r) => r.source).sort(), ['2001:db8:a:b::/64', '2001:db8:a:c::/64']);
});

test('one source holds at most 20 waiting codes', async () => {
  relay.sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
     INSERT INTO enrollments (lookup, agent_id, sign_pub, statement, created_at, expires_at, source)
     SELECT 'src-' || i, 'a_src' || i, 'src' || i, '{}', 0, ${Date.now() + 3_600_000}, '2001:db8:c:d::/64' FROM n`,
  );
  try {
    const full = await postEnroll(statement(newIdentity()), '2001:db8:c:d::99');
    assert.equal(full.status, 429);
    assert.equal(full.data.error.code, 'too_many_waiting');
    assert.equal((await postEnroll(statement(newIdentity()), '2001:db8:c:e::99')).status, 201);
  } finally {
    relay.sql("DELETE FROM enrollments WHERE lookup LIKE 'src-%'");
  }
});

// ─── 8. poll limiting after auth, stale locks ────────────────────────────────

test('unsigned polls do not use up the agent’s poll budget', async () => {
  const agent = newIdentity();
  const s = statement(agent);
  assert.equal((await postEnroll(s)).status, 201);
  const path = `/v1/enroll/${s.payload.lookup}`;
  const stranger = newIdentity();
  for (let i = 0; i < 65; i++) {
    const r = await fetch(relay.direct + path, {
      headers: { [AUTH_HEADER]: signRequest(agentIdFor(b64(agent.signPub)), stranger, 'GET', path, new Uint8Array()) },
    });
    assert.equal(r.status, 401);
  }
  const ok = await fetch(relay.direct + path, {
    headers: { [AUTH_HEADER]: signRequest(agentIdFor(b64(agent.signPub)), agent, 'GET', path, new Uint8Array()) },
  });
  assert.equal(ok.status, 200);
});

test('a lock left by a dead process is taken over at once', async () => {
  const first = await register('locked');
  const dead = spawnSync('true');
  const lock = join(profileDir('locked'), 'register.lock');
  writeFileSync(lock, `${dead.pid} ${Date.now()}`);
  const started = Date.now();
  const again = await cli(relay, 'locked', ['register', '--json']);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.code, first.code);
  assert.ok(Date.now() - started < 5000, 'did not wait for the dead holder');
  assert.equal(existsSync(lock), false);
});

// ─── 6, 9c. claim window and late claims ─────────────────────────────────────

test('the claim window is issuedAt + 10 min whatever expiry the relay reports', async () => {
  relay.rewrite = async (call) => {
    if (call.method !== 'POST' || call.path !== '/v1/enroll') return;
    const data = JSON.parse(call.body);
    return { body: JSON.stringify({ ...data, expiresAt: data.expiresAt + 86_400_000 }) };
  };
  try {
    const reg = await register('clamp');
    const p = pendingOf('clamp');
    assert.equal(p.expiresAt, p.issuedAt + ENROLL_TTL_MS);
    assert.equal(reg.expiresAt, p.expiresAt);
  } finally {
    relay.rewrite = null;
  }
});

test('a claim that arrived in time still finalises after the code expired locally', async () => {
  const owner = await newOwner(relay);
  const reg = await register('late-claim');
  await owner.lookupEnrollment(reg.code);
  await owner.claimEnrollment(reg.code);
  const file = join(profileDir('late-claim'), 'pending.json');
  writeFileSync(file, JSON.stringify({ ...pendingOf('late-claim'), expiresAt: 1 }));
  const again = await cli(relay, 'late-claim', ['register', '--name', 'late-claim', '--json']);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.status, 'active');
  assert.equal(again.json.ownerFingerprint, owner.fingerprint());
});

test('lazy finalise also picks up a claim after local expiry', async () => {
  const owner = await newOwner(relay);
  const reg = await register('late-lazy');
  await owner.lookupEnrollment(reg.code);
  await owner.claimEnrollment(reg.code);
  writeFileSync(
    join(profileDir('late-lazy'), 'pending.json'),
    JSON.stringify({ ...pendingOf('late-lazy'), expiresAt: 1 }),
  );
  const status = await cli(relay, 'late-lazy', ['status', '--json']);
  assert.equal(status.code, 0, status.err);
  assert.equal(status.json.status, 'active');
});

// ─── 4. replace re-check ─────────────────────────────────────────────────────

test('replace refuses when the registration changed after the confirm sheet', async () => {
  const owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'rep-old', 'rep');
  const oldId = (await owner.agents()).agents.find((a) => a.name === 'rep')!.agentId;
  const reg = await register('rep-new', 'rep');
  const preview = await owner.lookupEnrollment(reg.code);
  assert.equal(preview.existing?.agentId, oldId);
  // the same agent key re-signs a different statement (the relay serves that one now)
  const agent = identityOf('rep-new');
  const lookup = lookupOf(reg.code);
  relay.rewrite = async (call) => {
    if (call.method !== 'GET' || call.path !== `/v1/owner/enrollments/${lookup}`) return;
    const data = JSON.parse(call.body);
    data.statement = signEnroll({ ...data.statement.payload, device: 'somewhere else (linux)' }, agent);
    return { body: JSON.stringify(data) };
  };
  try {
    await assert.rejects(
      () => owner.claimEnrollment(reg.code, { replace: true }),
      (e) => e instanceof EnrollmentError && e.code === 'changed',
    );
  } finally {
    relay.rewrite = null;
  }
  assert.equal((await owner.agents()).agents.find((a) => a.agentId === oldId)!.status, 'active');
  // a phone that never showed the sheet cannot replace either
  const stranger = await newOwner(relay);
  await assert.rejects(
    () => stranger.claimEnrollment(reg.code, { replace: true }),
    (e) => e instanceof EnrollmentError && e.code === 'changed',
  );
  // shown again, approved again: now it goes through
  await owner.lookupEnrollment(reg.code);
  await owner.claimEnrollment(reg.code, { replace: true });
  assert.equal((await owner.agents()).agents.find((a) => a.agentId === oldId)!.status, 'revoked');
});

// ─── 5. field shapes ─────────────────────────────────────────────────────────

let owner: OwnerClient;
let target: { agentId: string; boxPub: string };

test('the relay refuses envelopes with odd ref, createdAt or expiresAt', async () => {
  owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'fields');
  const a = (await owner.agents()).agents.find((x) => x.name === 'fields')!;
  target = { agentId: a.agentId, boxPub: a.boxPub };
  const post = (envelope: Envelope) => owner.api.call('POST', '/v1/envelopes', { envelope });
  for (const over of [
    { ref: `m_${'a'.repeat(26)}` },
    { createdAt: 'yesterday' },
    { expiresAt: '5' },
    { type: 'answer', ref: 'not-an-id' },
  ]) {
    await assert.rejects(
      () => post(ownerEnvelope(owner, target, over)),
      (e: any) => e.status === 400,
      JSON.stringify(over),
    );
  }
});

test('the agent rejects odd verified fields, and never echoes a malformed id', async () => {
  const withRef = ownerEnvelope(owner, target, { ref: `m_${'b'.repeat(26)}` });
  const badId = ownerEnvelope(owner, target, { id: 'm_NOT-AN-ID' });
  const odd = ownerEnvelope(owner, target, { scope: 'Bad Scope' });
  let served = false;
  relay.rewrite = async (call) => {
    if (served || !call.path.startsWith('/v1/inbox')) return;
    served = true;
    const data = JSON.parse(call.body);
    data.envelopes.push(row(withRef, 900_001), row(badId, 900_002), row(odd, 900_003));
    return { body: JSON.stringify(data) };
  };
  try {
    const got = await cli(relay, 'fields', ['inbox', '--json']);
    assert.equal(got.code, 0, got.err);
    assert.deepEqual(got.lines, [
      { t: 'rejected', id: withRef.core.id, code: 'bad_fields' },
      { t: 'rejected', id: null, code: 'bad_fields' },
      { t: 'rejected', id: odd.core.id, code: 'bad_fields' },
    ]);
    assert.ok(!got.out.includes('crafted'));
  } finally {
    relay.rewrite = null;
  }
});

test('something bogus pointing at a request does not keep wait from the real answer', async () => {
  const ask = await cli(relay, 'fields', ['ask', 'go?', '--json']);
  assert.equal(ask.code, 0, ask.err);
  const bogus = ownerEnvelope(owner, target, { ref: ask.json.id });
  relay.rewrite = async (call) => {
    if (!call.path.startsWith('/v1/replies')) return;
    const data = JSON.parse(call.body);
    data.envelopes.unshift(row(bogus, 1));
    return { body: JSON.stringify(data) };
  };
  try {
    const feed = await owner.feed(0, 500);
    const items = owner.openItems(feed.envelopes, (await owner.agents()).agents, await owner.ownerSignKeys());
    const agent = (await owner.agents()).agents.find((a) => a.name === 'fields')!;
    await owner.answer(
      items.find((i) => i.id === ask.json.id)!,
      agent,
      { answer: 'go' },
    );
    const waited = await cli(relay, 'fields', ['wait', ask.json.id, '--timeout', '10s']);
    assert.equal(waited.code, 0, waited.err);
    assert.equal(waited.out.trim(), 'go');
  } finally {
    relay.rewrite = null;
  }
});

// ─── 7. delivery before ack ──────────────────────────────────────────────────

test('watch --json --ack stops on a closed stdout and acks nothing it could not write', async () => {
  const id = await owner.send(
    'message',
    (await owner.agents()).agents.find((a) => a.name === 'fields')!,
    {
      text: 'nobody is reading',
    },
  );
  const [program, args] = cliCommand();
  const child = spawn(program, [...args, 'watch', '--json', '--ack', '--interval', '1s'], {
    env: cliEnv(relay, 'fields'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.destroy();
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 20_000);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  assert.notEqual(code, 0, err);
  assert.notEqual(code, null, 'watch kept running with nobody reading');
  const still = await cli(relay, 'fields', ['inbox', '--json']);
  assert.ok(
    still.lines.some((l) => l.id === id),
    'the message is still waiting',
  );
  await cli(relay, 'fields', ['ack', id]);
});

// ─── 9a. revocation rollback ─────────────────────────────────────────────────

test('the owner refuses to build on a revocation list older than one it signed', async () => {
  const o = await newOwner(relay);
  await enrollAgent(relay, o, 'rb-one');
  await enrollAgent(relay, o, 'rb-two');
  const { agents } = await o.agents();
  const one = agents.find((a) => a.name === 'rb-one')!;
  const two = agents.find((a) => a.name === 'rb-two')!;
  const old = await o.api.call<Record<string, unknown>>('GET', '/v1/directory');
  await o.revoke({ agents: [one.agentId] });
  assert.equal(o.state.revocationVersion, 1);
  // the relay serves the list from before: the next revocation would silently un-revoke rb-one
  relay.rewrite = async (call) => {
    if (call.method === 'GET' && call.path.startsWith('/v1/directory')) return { body: JSON.stringify(old) };
  };
  try {
    await assert.rejects(
      () => o.revoke({ agents: [two.agentId] }),
      (e) => e instanceof RollbackError,
    );
  } finally {
    relay.rewrite = null;
  }
  const now = await o.agents();
  assert.equal(now.agents.find((a) => a.agentId === one.agentId)!.status, 'revoked');
  assert.equal(now.agents.find((a) => a.agentId === two.agentId)!.status, 'active');
});

// ─── 9b. transient errors during a refresh ───────────────────────────────────

test('a failed directory refresh leaves the message unacked instead of rejecting it', async () => {
  const o = await newOwner(relay);
  await enrollAgent(relay, o, 'tr-x');
  // tr-x caches the directory before tr-y exists
  assert.equal((await cli(relay, 'tr-x', ['inbox', '--json'])).code, 0);
  const cached = JSON.parse(readFileSync(join(profileDir('tr-x'), 'directory.json'), 'utf8')).version;
  await enrollAgent(relay, o, 'tr-y');
  const { agents } = await o.agents();
  const x = agents.find((a) => a.name === 'tr-x')!;
  const y = agents.find((a) => a.name === 'tr-y')!;
  await o.grant({ from: y.agentId, to: x.agentId, scopes: ['message'] });
  const sent = await cli(relay, 'tr-y', ['send', 'tr-x', 'hello', '--json']);
  assert.equal(sent.code, 0, sent.err);
  // the relay keeps tr-x on its cached directory, then fails the refresh tr-y's unknown cert needs
  relay.rewrite = async (call) => {
    if (call.path.startsWith('/v1/inbox')) {
      return { body: JSON.stringify({ ...JSON.parse(call.body), dirVersion: cached }) };
    }
    if (call.path.startsWith('/v1/directory'))
      return { status: 503, body: '{"error":{"code":"down","message":"down"}}' };
  };
  const seen = relay.seen.length;
  try {
    const failed = await cli(relay, 'tr-x', ['inbox', '--json']);
    assert.notEqual(failed.code, 0);
    assert.ok(!failed.lines.some((l) => l.t === 'rejected'));
    assert.ok(!relay.seen.slice(seen).some((r) => r.startsWith('POST /v1/ack')));
  } finally {
    relay.rewrite = null;
  }
  const ok = await cli(relay, 'tr-x', ['inbox', '--json']);
  const msg = ok.lines.find((l) => l.id === sent.json.id);
  assert.equal(msg?.body.text, 'hello');
  assert.equal(msg?.from.name, 'tr-y');
});
