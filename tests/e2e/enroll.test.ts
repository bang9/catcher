// Agent-first registration end to end: the relay endpoints and limits, a malicious relay (played by the proxy and by
// an owner client whose fetch tampers with answers), an attacker owner, and the CLI's pending/finalise behaviour.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ApiError, EnrollmentError } from '@catcher/client';
import {
  agentIdFor,
  AUTH_HEADER,
  b64,
  type EnrollPayload,
  enrollParts,
  type Identity,
  identityFromSeed,
  newIdentity,
  publicKeys,
  randomBytes,
  sealClaim,
  type Signed,
  signEnroll,
  signRequest,
  signStatement,
  unb64,
} from '@catcher/protocol';
import { cli, enrollAgent, newOwner, nextIp, type Relay, startRelay } from './harness.ts';

let relay: Relay;

const BAD_CLAIM = /claimed by someone who did not have it, or the relay tampered\. Nothing was trusted/;

before(async () => {
  relay = await startRelay();
});

after(() => relay?.stop());

const profileDir = (home: string) => join(relay.work, home, 'profiles', 'default');
const hasState = (home: string) => existsSync(join(profileDir(home), 'state.json'));
const hasPending = (home: string) => existsSync(join(profileDir(home), 'pending.json'));

function freshLookup(): string {
  return enrollParts(randomBytes(10)).lookup;
}

function enrollStatement(agent: Identity, over: Partial<EnrollPayload> = {}): Signed<EnrollPayload> {
  return signEnroll(
    {
      lookup: over.lookup ?? freshLookup(),
      name: over.name ?? 'raw',
      device: over.device ?? 'test (darwin)',
      provider: over.provider ?? 'test',
      issuedAt: over.issuedAt ?? Date.now(),
    },
    agent,
  );
}

async function postEnroll(body: unknown, ip = nextIp()): Promise<{ status: number; data: any }> {
  const r = await fetch(`${relay.direct}/v1/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

async function pollAs(agent: Identity, lookup: string, callerId = agentIdFor(b64(agent.signPub))) {
  const path = `/v1/enroll/${lookup}`;
  const r = await fetch(relay.direct + path, {
    headers: { [AUTH_HEADER]: signRequest(callerId, agent, 'GET', path, new Uint8Array()) },
  });
  return { status: r.status, data: await r.json() };
}

/** `catcher register --name <name> --json` → its pending answer */
async function register(home: string, name = home): Promise<any> {
  const r = await cli(relay, home, ['register', '--name', name, '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json.status, 'pending');
  return r.json;
}

async function expect(body: unknown, status: number, code: string): Promise<void> {
  const r = await postEnroll(body);
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.equal(r.data.error.code, code);
}

function fillEnrollments(expires: number): void {
  relay.sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
     INSERT INTO enrollments (lookup, agent_id, sign_pub, statement, created_at, expires_at)
     SELECT 'fill-' || i, 'a_fill' || i, 'fill' || i, '{}', 0, ${expires} FROM n`,
  );
}

// ─── relay ───────────────────────────────────────────────────────────────────

test('enroll: created, idempotent for the same statement, lookup_taken, key_taken', async () => {
  const agent = newIdentity();
  const statement = enrollStatement(agent);
  const first = await postEnroll({ statement });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.agentId, agentIdFor(b64(agent.signPub)));
  assert.ok(first.data.expiresAt > Date.now() + 9 * 60_000 && first.data.expiresAt <= Date.now() + 10 * 60_000);
  // the same agent posting again after a lost answer gets the same answer
  const again = await postEnroll({ statement });
  assert.equal(again.status, 200);
  assert.equal(again.data.agentId, first.data.agentId);
  // same lookup and key, but a different statement: not a retry
  const changed = await postEnroll({
    statement: enrollStatement(agent, { lookup: statement.payload.lookup, name: 'other' }),
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.data.error.code, 'lookup_taken');
  const other = await postEnroll({ statement: enrollStatement(newIdentity(), { lookup: statement.payload.lookup }) });
  assert.equal(other.status, 409);
  assert.equal(other.data.error.code, 'lookup_taken');
  const sameKey = await postEnroll({ statement: enrollStatement(agent) });
  assert.equal(sameKey.status, 409);
  assert.equal(sameKey.data.error.code, 'key_taken');
});

test('enroll: refuses stale, oversized, misnamed, malformed and forged statements', async () => {
  const agent = newIdentity();
  await expect({ statement: enrollStatement(agent, { issuedAt: Date.now() - 11 * 60_000 }) }, 400, 'stale');
  await expect({ statement: enrollStatement(agent, { device: 'd'.repeat(81) }) }, 400, 'too_long');
  await expect({ statement: enrollStatement(agent, { provider: 'p'.repeat(41) }) }, 400, 'too_long');
  await expect({ statement: enrollStatement(agent), pad: 'x'.repeat(2048) }, 400, 'too_long');
  await expect({ statement: enrollStatement(agent, { name: 'owner' }) }, 400, 'bad_name');
  await expect({ statement: enrollStatement(agent, { name: 'Has Space' }) }, 400, 'bad_name');
  await expect({ statement: enrollStatement(agent, { lookup: 'UUUUU' }) }, 400, 'bad_lookup');
  await expect({ statement: enrollStatement(agent, { lookup: 'ABCD' }) }, 400, 'bad_lookup');
  const s = enrollStatement(agent);
  // signed by a key other than the one it registers
  await expect({ statement: { ...s, signer: b64(newIdentity().signPub) } }, 400, 'bad_statement');
  await expect({ statement: { ...s, payload: { ...s.payload, name: 'renamed' } } }, 400, 'bad_statement');
});

test('enroll: 5 a minute per client IP', async () => {
  const ip = nextIp();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++)
    statuses.push((await postEnroll({ statement: enrollStatement(newIdentity()) }, ip)).status);
  assert.deepEqual(statuses.slice(0, 5), [201, 201, 201, 201, 201]);
  assert.equal(statuses[5], 429);
});

test('enroll: busy when 5,000 codes are waiting; expired ones do not count', async () => {
  fillEnrollments(Date.now() + 3_600_000);
  try {
    const busy = await postEnroll({ statement: enrollStatement(newIdentity()) });
    assert.equal(busy.status, 503);
    assert.equal(busy.data.error.code, 'busy');
  } finally {
    relay.sql("DELETE FROM enrollments WHERE lookup LIKE 'fill-%'");
  }
  fillEnrollments(1);
  try {
    assert.equal((await postEnroll({ statement: enrollStatement(newIdentity()) })).status, 201);
  } finally {
    relay.sql("DELETE FROM enrollments WHERE lookup LIKE 'fill-%'");
  }
});

test('poll: only the enrolling key may read its registration', async () => {
  const agent = newIdentity();
  const s = enrollStatement(agent);
  assert.equal((await postEnroll({ statement: s })).status, 201);
  const ok = await pollAs(agent, s.payload.lookup);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'waiting');
  const stranger = newIdentity();
  assert.equal((await pollAs(stranger, s.payload.lookup, agentIdFor(b64(agent.signPub)))).status, 401);
  assert.equal((await pollAs(stranger, s.payload.lookup)).status, 401);
  const unsigned = await fetch(`${relay.direct}/v1/enroll/${s.payload.lookup}`);
  assert.equal(unsigned.status, 401);
  assert.equal((await pollAs(agent, freshLookup())).status, 404);
});

test('the 0.1 pairing endpoints are gone (410)', async () => {
  for (const path of ['/v1/register', '/v1/owner/pairings', '/v1/owner/agents/a_0000000000000000/reject']) {
    const r = await fetch(relay.direct + path, { method: 'POST', body: '{}' });
    assert.equal(r.status, 410, path);
  }
});

test('claim: creates an active certified agent and bumps the directory version', async () => {
  const owner = await newOwner(relay);
  const dirBefore = await owner.api.call<{ version: number }>('GET', '/v1/directory');
  const reg = await register('fresh');
  const preview = await owner.lookupEnrollment(reg.code);
  assert.equal(preview.name, 'fresh');
  assert.equal(preview.agentId, reg.agentId);
  assert.equal(preview.existing, undefined);
  await owner.claimEnrollment(reg.code);
  const afterClaim = await owner.api.call<{ version: number }>('GET', '/v1/directory');
  assert.equal(afterClaim.version, dirBefore.version + 1);
  const { agents } = await owner.agents();
  const agent = agents.find((a) => a.agentId === reg.agentId)!;
  assert.equal(agent.status, 'active');
  assert.equal(agent.cert?.payload.name, 'fresh');
  // the real owner's app says "already used"
  await assert.rejects(
    () => owner.lookupEnrollment(reg.code),
    (e) => e instanceof ApiError && e.code === 'claimed',
  );
  // the agent's first authenticated call shortens the claimed row's life to a day
  const done = await cli(relay, 'fresh', ['register', '--wait', '--json']);
  assert.equal(done.code, 0, done.err);
  let row: Record<string, unknown> | undefined;
  for (let i = 0; i < 20; i++) {
    row = relay.sql(`SELECT expires_at FROM enrollments WHERE agent_id = '${reg.agentId}'`)[0];
    if (row && Number(row.expires_at) < Date.now() + 2 * 86_400_000) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const left = Number(row?.expires_at) - Date.now();
  assert.ok(left > 23 * 3_600_000 && left <= 24 * 3_600_000, `claimed row expires in ${left} ms`);
});

test('claim race: two owners with the same code — one 201, one 409', async () => {
  const [o1, o2] = [await newOwner(relay), await newOwner(relay)];
  const reg = await register('racer');
  await o1.lookupEnrollment(reg.code);
  await o2.lookupEnrollment(reg.code);
  const results = await Promise.allSettled([o1.claimEnrollment(reg.code), o2.claimEnrollment(reg.code)]);
  const won = results.findIndex((r) => r.status === 'fulfilled');
  const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  assert.ok(won >= 0 && lost, JSON.stringify(results));
  assert.ok(lost.reason instanceof ApiError && lost.reason.status === 409, String(lost.reason));
  const done = await cli(relay, 'racer', ['register', '--wait', '--json']);
  assert.equal(done.code, 0, done.err);
  assert.equal(done.json.ownerFingerprint, [o1, o2][won]!.fingerprint());
});

test('name taken: the code stays claimable; replace revokes the old agent first', async () => {
  const owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'dup-old', 'dup');
  const oldId = (await owner.agents()).agents.find((a) => a.name === 'dup')!.agentId;
  const reg = await register('dup-new', 'dup');
  const preview = await owner.lookupEnrollment(reg.code);
  assert.equal(preview.existing?.agentId, oldId);
  await assert.rejects(
    () => owner.claimEnrollment(reg.code),
    (e) => e instanceof ApiError && e.code === 'name_taken',
  );
  // still open
  assert.equal((await owner.lookupEnrollment(reg.code)).agentId, reg.agentId);
  await owner.claimEnrollment(reg.code, { replace: true });
  const { agents } = await owner.agents();
  assert.equal(agents.find((a) => a.agentId === oldId)!.status, 'revoked');
  assert.equal(agents.find((a) => a.agentId === reg.agentId)!.status, 'active');
  const done = await cli(relay, 'dup-new', ['register', '--wait', '--json']);
  assert.equal(done.code, 0, done.err);
  assert.equal((await cli(relay, 'dup-old', ['inbox'])).code, 6);
});

test('replace with a code that is no longer valid never revokes the old agent', async () => {
  const owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'kept-old', 'kept');
  const oldId = (await owner.agents()).agents.find((a) => a.name === 'kept')!.agentId;
  const reg = await register('kept-new', 'kept');
  assert.equal((await owner.lookupEnrollment(reg.code)).existing?.agentId, oldId);
  // someone else uses the code after the confirm sheet was shown
  const other = await newOwner(relay);
  await other.lookupEnrollment(reg.code);
  await other.claimEnrollment(reg.code);
  await assert.rejects(
    () => owner.claimEnrollment(reg.code, { replace: true }),
    (e) => e instanceof ApiError && e.code === 'claimed',
  );
  assert.equal((await owner.agents()).agents.find((a) => a.agentId === oldId)!.status, 'active');
});

test('replace target comes from signed certs, never from the relay', async () => {
  const owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'keeper');
  const keeperId = (await owner.agents()).agents.find((a) => a.name === 'keeper')!.agentId;
  const reg = await register('newbie');
  // a lying relay claims "keeper" is the same-name agent to replace
  relay.rewrite = async (call) => {
    if (call.method !== 'GET' || !call.path.startsWith('/v1/owner/enrollments/')) return;
    return { body: JSON.stringify({ ...JSON.parse(call.body), existing: { agentId: keeperId } }) };
  };
  try {
    const preview = await owner.lookupEnrollment(reg.code);
    assert.equal(preview.existing, undefined);
    await assert.rejects(
      () => owner.claimEnrollment(reg.code, { replace: true }),
      (e) => e instanceof EnrollmentError && e.code === 'nothing_to_replace',
    );
  } finally {
    relay.rewrite = null;
  }
  assert.equal((await owner.agents()).agents.find((a) => a.agentId === keeperId)!.status, 'active');
});

test('expired code: owner gets bad_code, the agent exits 4, a re-run makes a fresh code', async () => {
  const owner = await newOwner(relay);
  const reg = await register('late');
  relay.sql(`UPDATE enrollments SET expires_at = 1 WHERE agent_id = '${reg.agentId}'`);
  await assert.rejects(
    () => owner.lookupEnrollment(reg.code),
    (e) => e instanceof ApiError && e.code === 'bad_code',
  );
  const waited = await cli(relay, 'late', ['register', '--wait', '--timeout', '10s']);
  assert.equal(waited.code, 4, waited.err);
  assert.match(waited.err, /expired/);
  assert.equal(hasPending('late'), false);
  const again = await register('late');
  assert.notEqual(again.code, reg.code);
  assert.notEqual(again.agentId, reg.agentId);
});

test('cleanup: expired codes go on the hourly run', async () => {
  const s = enrollStatement(newIdentity());
  assert.equal((await postEnroll({ statement: s })).status, 201);
  relay.sql(`UPDATE enrollments SET expires_at = 1 WHERE lookup = '${s.payload.lookup}'`);
  await relay.scheduled();
  assert.equal(relay.sql(`SELECT lookup FROM enrollments WHERE lookup = '${s.payload.lookup}'`).length, 0);
});

// ─── malicious relay, attacker owner ─────────────────────────────────────────

test('swapped enroll statement: the tag does not match, nothing is claimed, 3 strikes lock the code', async () => {
  const reg = await register('swap');
  const lookup = reg.code.replace(/-/g, '').slice(0, 5);
  const attacker = newIdentity();
  let lookups = 0;
  // the relay answers with its own agent's statement under the same lookup
  const tamper = async (input: string, init?: RequestInit) => {
    const res = await fetch(input, init);
    if (!input.includes(`/v1/owner/enrollments/${lookup}`)) return res;
    lookups += 1;
    const data = await res.json();
    data.statement = signEnroll({ ...data.statement.payload }, attacker);
    return new Response(JSON.stringify(data), { status: res.status, headers: res.headers });
  };
  const owner = await newOwner(relay, tamper as typeof fetch);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      () => owner.lookupEnrollment(reg.code),
      (e) => e instanceof EnrollmentError && e.code === 'tag_mismatch',
    );
  }
  await assert.rejects(
    () => owner.lookupEnrollment(reg.code),
    (e) => e instanceof EnrollmentError && e.code === 'locked',
  );
  assert.equal(lookups, 3, 'the fourth try never reaches the relay');
  assert.equal((await cli(relay, 'swap', ['status'])).code, 6);
  assert.equal(hasState('swap'), false);
});

test('attacker owner claims a code it does not have: the agent trusts nothing and exits 7', async () => {
  const reg = await register('victim');
  const lookup = reg.code.replace(/-/g, '').slice(0, 5);
  const attacker = await newOwner(relay);
  // skips every app-side check: fetches the statement by lookup and claims with a guessed secret
  const { statement } = await attacker.api.call<{ statement: Signed<EnrollPayload> }>(
    'GET',
    `/v1/owner/enrollments/${lookup}`,
  );
  const p = statement.payload;
  const now = Date.now();
  const cert = signStatement(
    {
      kind: 'cert',
      ownerId: attacker.state.ownerId,
      agentId: reg.agentId,
      name: p.name,
      signPub: p.signPub,
      boxPub: p.boxPub,
      device: p.device,
      provider: p.provider,
      issuedAt: now,
      expiresAt: now + 86_400_000,
      revocationFloor: 0,
    },
    attacker.identity,
  );
  const claim = sealClaim({
    owner: attacker.identity,
    ownerId: attacker.state.ownerId,
    lookup,
    secret: 'ZZZZZ',
    agentId: reg.agentId,
    agentSignPub: p.signPub,
    agentBoxPub: p.boxPub,
  });
  await attacker.api.call('POST', `/v1/owner/enrollments/${lookup}/claim`, { claim, cert });
  const waited = await cli(relay, 'victim', ['register', '--wait']);
  assert.equal(waited.code, 7, waited.err);
  assert.match(waited.err, BAD_CLAIM);
  assert.equal(hasState('victim'), false);
  assert.equal(hasPending('victim'), false);
  // the real owner's app says the code was used
  const real = await newOwner(relay);
  await assert.rejects(
    () => real.lookupEnrollment(reg.code),
    (e) => e instanceof ApiError && e.code === 'claimed',
  );
});

test('relay serves a forged claim: exit 7, nothing pinned', async () => {
  const reg = await register('forged');
  const lookup = reg.code.replace(/-/g, '').slice(0, 5);
  const evil = newIdentity();
  const { boxPub, signPub } = publicKeysOfPending('forged');
  relay.rewrite = async (call) => {
    if (call.path !== `/v1/enroll/${lookup}`) return;
    const claim = sealClaim({
      owner: evil,
      ownerId: 'o_00000000000000000000',
      lookup,
      secret: 'ZZZZZ',
      agentId: reg.agentId,
      agentSignPub: signPub,
      agentBoxPub: boxPub,
    });
    return { status: 200, body: JSON.stringify({ status: 'claimed', claim, cert: null }) };
  };
  try {
    const waited = await cli(relay, 'forged', ['register', '--wait']);
    assert.equal(waited.code, 7, waited.err);
    assert.match(waited.err, BAD_CLAIM);
  } finally {
    relay.rewrite = null;
  }
  assert.equal(hasState('forged'), false);
});

function publicKeysOfPending(home: string): { signPub: string; boxPub: string } {
  const pending = JSON.parse(readFileSync(join(profileDir(home), 'pending.json'), 'utf8'));
  return publicKeys(identityFromSeed(unb64(pending.seed)));
}

test('claim replay: ignored after finalising, refused by another agent', async () => {
  const owner = await newOwner(relay);
  const regA = await register('replay-a');
  await owner.lookupEnrollment(regA.code);
  await owner.claimEnrollment(regA.code);
  // capture A's claim as the relay serves it
  let captured = '';
  relay.rewrite = async (call) => {
    if (call.path.startsWith('/v1/enroll/') && call.body.includes('"claimed"')) captured = call.body;
  };
  try {
    assert.equal((await cli(relay, 'replay-a', ['register', '--wait'])).code, 0);
  } finally {
    relay.rewrite = null;
  }
  assert.ok(captured);
  const stateBefore = readFileSync(join(profileDir('replay-a'), 'state.json'), 'utf8');
  // A is registered: running register again never looks at a claim
  relay.rewrite = async (call) => {
    if (call.path.startsWith('/v1/enroll/')) return { status: 200, body: captured };
  };
  try {
    const again = await cli(relay, 'replay-a', ['register', '--wait']);
    assert.equal(again.code, 0, again.err);
    assert.equal(readFileSync(join(profileDir('replay-a'), 'state.json'), 'utf8'), stateBefore);
    // B is served A's claim: wrong lookup, agent and keys
    await register('replay-b');
    const b = await cli(relay, 'replay-b', ['register', '--wait']);
    assert.equal(b.code, 7, b.err);
    assert.equal(hasState('replay-b'), false);
  } finally {
    relay.rewrite = null;
  }
});

// ─── CLI behaviour ───────────────────────────────────────────────────────────

test('re-running register shows the same code; a different name starts over', async () => {
  const first = await register('again');
  const second = await register('again');
  assert.equal(second.code, first.code);
  assert.equal(second.agentId, first.agentId);
  const plain = await cli(relay, 'again', ['register']);
  assert.equal(plain.code, 0);
  assert.ok(plain.out.includes(first.code));
  assert.ok(plain.out.includes(`${relay.server}/r#${first.code}`));
  // the seed and the secret part never appear on their own
  const pending = JSON.parse(readFileSync(join(profileDir('again'), 'pending.json'), 'utf8'));
  assert.ok(!plain.out.includes(pending.seed) && !plain.err.includes(pending.seed));
  const renamed = await register('again', 'again-two');
  assert.notEqual(renamed.code, first.code);
});

test('lost enroll answer: exit 1, the code is kept (0600) and a re-run picks it up', async () => {
  let failed = false;
  relay.rewrite = async (call) => {
    if (call.method === 'POST' && call.path === '/v1/enroll' && !failed) {
      failed = true;
      return { status: 502, body: 'bad gateway' };
    }
  };
  try {
    const lost = await cli(relay, 'lossy', ['register', '--name', 'lossy']);
    assert.equal(lost.code, 1, lost.err);
  } finally {
    relay.rewrite = null;
  }
  const file = join(profileDir('lossy'), 'pending.json');
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const first = JSON.parse(readFileSync(file, 'utf8'));
  // the relay did store it; the re-run posts the same statement again and gets the same answer
  const again = await register('lossy');
  assert.equal(again.agentId, first.agentId);
  const owner = await newOwner(relay);
  await owner.lookupEnrollment(again.code);
  await owner.claimEnrollment(again.code);
  const done = await cli(relay, 'lossy', ['register', '--wait', '--json']);
  assert.equal(done.code, 0, done.err);
});

test('genuine claim but no valid cert from the relay: nothing written, the registration is kept', async () => {
  const owner = await newOwner(relay);
  const reg = await register('certless');
  await owner.lookupEnrollment(reg.code);
  await owner.claimEnrollment(reg.code);
  relay.rewrite = async (call) => {
    if (!call.path.startsWith('/v1/enroll/') || !call.body.includes('"claimed"')) return;
    return { body: JSON.stringify({ ...JSON.parse(call.body), cert: null }) };
  };
  try {
    const waited = await cli(relay, 'certless', ['register', '--wait', '--timeout', '5s']);
    assert.equal(waited.code, 1, waited.err);
    assert.equal(hasState('certless'), false);
    assert.equal(hasPending('certless'), true);
  } finally {
    relay.rewrite = null;
  }
  const done = await cli(relay, 'certless', ['register', '--wait', '--json']);
  assert.equal(done.code, 0, done.err);
  assert.equal(done.json.ownerFingerprint, owner.fingerprint());
});

test('lazy finalise: the next command after the owner approved finishes the registration', async () => {
  const owner = await newOwner(relay);
  const reg = await register('lazy');
  const early = await cli(relay, 'lazy', ['inbox']);
  assert.equal(early.code, 6);
  assert.ok(early.err.includes(reg.code));
  await owner.lookupEnrollment(reg.code);
  await owner.claimEnrollment(reg.code);
  const status = await cli(relay, 'lazy', ['status', '--json']);
  assert.equal(status.code, 0, status.err);
  assert.equal(status.json.status, 'active');
  assert.equal(status.json.ownerFingerprint, owner.fingerprint());
  assert.equal(hasPending('lazy'), false);
});

test('two finalisers at once: both succeed, one state file', async () => {
  const owner = await newOwner(relay);
  const reg = await register('twins');
  await owner.lookupEnrollment(reg.code);
  await owner.claimEnrollment(reg.code);
  const [a, b] = await Promise.all([
    cli(relay, 'twins', ['register', '--wait', '--json']),
    cli(relay, 'twins', ['status', '--json']),
  ]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.equal(a.json.agentId, reg.agentId);
  assert.equal(b.json.agentId, reg.agentId);
  const state = JSON.parse(readFileSync(join(profileDir('twins'), 'state.json'), 'utf8'));
  assert.equal(state.ownerId, owner.state.ownerId);
  assert.equal(hasPending('twins'), false);
  assert.equal(existsSync(join(profileDir('twins'), 'register.lock')), false);
});

test('owner side checks the code before anything leaves the phone', async () => {
  const owner = await newOwner(relay);
  const seenCount = relay.seen.length;
  for (const bad of ['1234', 'ABCD-EFGH-JKMN-PQRU', '0000-0000-003F-EF10']) {
    await assert.rejects(
      () => owner.lookupEnrollment(bad),
      (e) => (e as { code?: string }).code?.startsWith('bad_'),
    );
  }
  assert.equal(relay.seen.length, seenCount);
});
