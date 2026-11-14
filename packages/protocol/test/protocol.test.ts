import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  b32,
  b64,
  buildTrust,
  canonical,
  checkEnvelope,
  type Directory,
  type Envelope,
  fingerprint,
  identityFromSeed,
  type Identity,
  openEnvelope,
  ownerIdFor,
  parseAuth,
  PolicyError,
  publicKeys,
  recoveryCode,
  sealEnvelope,
  seedFromRecoveryCode,
  sha256,
  signRequest,
  signStatement,
  unb32,
  unb64,
  utf8,
  verifyEnvelope,
  verifyOwnerChain,
  verifyRequest,
  verifyStatement,
} from '../src/index.ts';

const det = (tag: string) => {
  let n = 0;
  return (len: number) => {
    const out = new Uint8Array(len);
    let o = 0;
    while (o < len) {
      const h = sha256(utf8(`${tag}/${n++}`));
      out.set(h.subarray(0, Math.min(32, len - o)), o);
      o += 32;
    }
    return out;
  };
};

const owner = identityFromSeed(new Uint8Array(32).fill(1));
const agentA = identityFromSeed(new Uint8Array(32).fill(2));
const agentB = identityFromSeed(new Uint8Array(32).fill(3));
const outsider = identityFromSeed(new Uint8Array(32).fill(9));
const ownerId = ownerIdFor(b64(owner.signPub));
const A = `a_${'1'.repeat(16)}`;
const B = `a_${'2'.repeat(16)}`;
const NOW = 1_700_000_000_000;

const party = (id: string, who: Identity) => ({ id, boxPub: b64(who.boxPub) });
const genesis = signStatement({ kind: 'owner-key', ownerId, seq: 0, ...publicKeys(owner), issuedAt: NOW }, owner);
const cert = (agentId: string, who: Identity, signer = owner) =>
  signStatement(
    {
      kind: 'cert',
      ownerId,
      agentId,
      name: agentId,
      ...publicKeys(who),
      device: 'test',
      provider: 'test',
      issuedAt: NOW,
      expiresAt: NOW + 86_400_000,
    },
    signer,
  );

function directory(extra: Partial<Directory> = {}): Directory {
  return {
    ownerId,
    ownerChain: [genesis],
    revocations: null,
    certs: [cert(A, agentA), cert(B, agentB)],
    grants: [],
    ...extra,
  };
}
const pin = { ownerId, ...publicKeys(owner) };

test('frozen vectors: keys, ids, fingerprint, recovery code, signatures', () => {
  assert.deepEqual(publicKeys(owner), {
    signPub: 'FiDeeNlCobI2KraFUYA5Qhh9n92fb9R0bdkubPLj4uk',
    boxPub: '_ZzNaNjdHKQGU-z1zJZFp8sklb-e7d0-Aj9R80IDFE8',
  });
  assert.equal(ownerId, 'o_bftqn1ntzbdcw2szt530');
  assert.equal(fingerprint(publicKeys(owner)), '4RNJ-70Y7-RZ6B-F3JS');
  assert.equal(recoveryCode(owner.seed), '040G2-08104-0G208-1040G-20810-40G20-81040-G2081-040G2-08104-0KX4R');
  const env = sealEnvelope({
    id: `m_${'0'.repeat(26)}`,
    ownerId,
    from: A,
    to: ownerId,
    type: 'ask',
    seq: 1,
    body: { question: 'merge?' },
    createdAt: NOW,
    sender: agentA,
    recipients: [party(ownerId, owner), party(A, agentA)],
    random: det('v'),
  });
  assert.equal(env.ctHash, 'cbVU5OQFrejRhu1VVLKg8gYDwQyFNL_sdtTsotKVeFY');
  assert.equal(env.sig, '0UWL0EbVeoRbAYbi2VbAdPWGs0Hx-JvEHb8jIG-Q8UnugFNzULmxf9lbO4BQ3LXlI4XRGsR78R1VC25KcBH1Cw');
  assert.equal(
    signStatement({ kind: 'pairing', ownerId, issuedAt: NOW }, owner).sig,
    'GTkP2wrWAKF11LFxPdcyacbmpVrKD9XL2jyixpG1eBJ4HMfWXuTmQCD5BkU-IMoUjCsnd8x6x1JHu2JSU6TnBA',
  );
});

test('encodings round-trip', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = sha256(utf8(String(n))).subarray(0, n % 33);
    assert.deepEqual(unb64(b64(bytes)), bytes);
    assert.deepEqual(unb32(b32(bytes)).subarray(0, bytes.length), bytes);
  }
  assert.equal(canonical({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonical({ x: 1.5 }));
});

test('recovery code restores the seed and catches typos', () => {
  const code = recoveryCode(owner.seed);
  assert.deepEqual(seedFromRecoveryCode(code.toLowerCase()), owner.seed);
  let swapped = 'Z';
  if (code[3] === 'Z') swapped = 'Y';
  const typo = `${code.slice(0, 3)}${swapped}${code.slice(4)}`;
  assert.throws(() => seedFromRecoveryCode(typo), /typo/);
});

function sealAB(overrides: Partial<Parameters<typeof sealEnvelope>[0]> = {}): Envelope {
  return sealEnvelope({
    id: `m_${'a'.repeat(26)}`,
    ownerId,
    from: A,
    to: B,
    type: 'message',
    seq: 1,
    body: { text: 'hello' },
    scope: 'message',
    grantId: `g_${'1'.repeat(16)}`,
    createdAt: NOW,
    sender: agentA,
    recipients: [party(A, agentA), party(B, agentB), party(ownerId, owner)],
    ...overrides,
  } as Parameters<typeof sealEnvelope>[0]);
}

test('every recipient (target, owner, sender) can open; outsiders cannot', () => {
  const env = sealAB();
  verifyEnvelope(env, b64(agentA.signPub));
  assert.deepEqual(openEnvelope(env, { id: B, ...agentB }), { text: 'hello' });
  assert.deepEqual(openEnvelope(env, { id: ownerId, ...owner }), { text: 'hello' });
  assert.deepEqual(openEnvelope(env, { id: A, ...agentA }), { text: 'hello' });
  assert.throws(() => openEnvelope(env, { id: 'a_zzzzzzzzzzzzzzzz', ...outsider }));
  // outsider pretending to be B still cannot unwrap B's key
  assert.throws(() => openEnvelope(env, { id: B, ...outsider }));
});

test('tampering is caught: stripped owner copy, edited core, swapped ciphertext, re-signed by another agent', () => {
  const env = sealAB();
  const stripped = { ...env, wraps: env.wraps.filter((w) => w.to !== ownerId) };
  assert.throws(() => verifyEnvelope(stripped, b64(agentA.signPub)), /not readable by/);
  const edited = { ...env, core: { ...env.core, scope: 'calendar.read' } };
  assert.throws(() => verifyEnvelope(edited, b64(agentA.signPub)), /signature/);
  const other = sealAB({ body: { text: 'evil' } });
  assert.throws(() => verifyEnvelope({ ...env, ct: other.ct }, b64(agentA.signPub)), /hash/);
  // B takes A's ciphertext and signs it as itself: the core still says from=A, and A's key does not verify B's sig
  assert.throws(() => verifyEnvelope({ ...env, sig: other.sig }, b64(agentA.signPub)), /signature/);
});

test('trust: certs and grants must be signed by the current owner key', () => {
  const forgedCert = cert('a_ffffffffffffffff', outsider, outsider);
  const trust = buildTrust(directory({ certs: [cert(A, agentA), cert(B, agentB), forgedCert] }), pin, 0, NOW);
  assert.deepEqual([...trust.agents.keys()].sort(), [A, B]);
});

test('policy: agent → agent needs a live grant covering the scope', () => {
  const grantId = `g_${'1'.repeat(16)}`;
  const grant = signStatement(
    {
      kind: 'grant',
      ownerId,
      grantId,
      from: A,
      to: B,
      scopes: ['message'],
      requireApproval: false,
      issuedAt: NOW,
      expiresAt: null,
    },
    owner,
  );
  const env = sealAB();
  assert.throws(
    () => checkEnvelope(buildTrust(directory(), pin, 0, NOW), env, { now: NOW }),
    (e: unknown) => (e as PolicyError).code === 'no_grant',
  );
  const trust = buildTrust(directory({ grants: [grant] }), pin, 0, NOW);
  checkEnvelope(trust, env, { now: NOW });
  const wrongScope = sealAB({ scope: 'calendar.read' });
  assert.throws(() => checkEnvelope(trust, wrongScope, { now: NOW }), /does not cover/);
  // reverse direction is not covered
  const back = sealEnvelope({
    id: `m_${'b'.repeat(26)}`,
    ownerId,
    from: B,
    to: A,
    type: 'message',
    seq: 1,
    body: { text: 'hi' },
    scope: 'message',
    grantId,
    createdAt: NOW,
    sender: agentB,
    recipients: [party(A, agentA), party(B, agentB), party(ownerId, owner)],
  });
  assert.throws(() => checkEnvelope(trust, back, { now: NOW }), /does not cover/);
});

test('policy: requireApproval grants need an owner release bound to the exact ciphertext', () => {
  const grantId = `g_${'1'.repeat(16)}`;
  const grant = signStatement(
    {
      kind: 'grant',
      ownerId,
      grantId,
      from: A,
      to: B,
      scopes: ['message'],
      requireApproval: true,
      issuedAt: NOW,
      expiresAt: null,
    },
    owner,
  );
  const trust = buildTrust(directory({ grants: [grant] }), pin, 0, NOW);
  const env = sealAB();
  assert.throws(
    () => checkEnvelope(trust, env, { now: NOW }),
    (e: unknown) => (e as PolicyError).code === 'held',
  );
  const release = signStatement(
    { kind: 'release', ownerId, envelopeId: env.core.id, ctHash: env.ctHash, issuedAt: NOW },
    owner,
  );
  checkEnvelope(trust, env, { now: NOW, release });
  const fakeRelease = signStatement(
    { kind: 'release', ownerId, envelopeId: env.core.id, ctHash: env.ctHash, issuedAt: NOW },
    agentA,
  );
  assert.throws(() => checkEnvelope(trust, env, { now: NOW, release: fakeRelease }), /signed by the expected key/);
  const otherEnv = sealAB({ body: { text: 'different' } });
  assert.throws(() => checkEnvelope(trust, otherEnv, { now: NOW, release }), /does not match/);
});

test('revocations: revoked agents drop out and an older list is a rollback', () => {
  const rev = (version: number, agents: string[]) =>
    signStatement({ kind: 'revocations', ownerId, version, agents, grants: [], issuedAt: NOW }, owner);
  const trust = buildTrust(directory({ revocations: rev(2, [B]) }), pin, 0, NOW);
  assert.equal(trust.agents.has(B), false);
  assert.equal(trust.revocationVersion, 2);
  assert.throws(() => buildTrust(directory({ revocations: rev(1, []) }), pin, 2, NOW), /older revocation list/);
  assert.throws(() => buildTrust(directory(), pin, 1, NOW), /older revocation list/);
});

test('owner key rotation: agents pinned to the old key follow the chain', () => {
  const next = identityFromSeed(new Uint8Array(32).fill(7));
  const link = signStatement({ kind: 'owner-key', ownerId, seq: 1, ...publicKeys(next), issuedAt: NOW }, owner);
  assert.equal(verifyOwnerChain([genesis, link], ownerId).signPub, b64(next.signPub));
  const reSigned = [cert(A, agentA, next), cert(B, agentB, next)];
  const trust = buildTrust(directory({ ownerChain: [genesis, link], certs: reSigned }), pin, 0, NOW);
  assert.equal(trust.owner.signPub, b64(next.signPub));
  assert.equal(trust.agents.size, 2);
  // a link signed by a stranger breaks the chain
  const bad = signStatement({ kind: 'owner-key', ownerId, seq: 1, ...publicKeys(outsider), issuedAt: NOW }, outsider);
  assert.throws(() => verifyOwnerChain([genesis, bad], ownerId), /signed by the expected key/);
});

test('request auth: signature binds method, path, body and time', () => {
  const body = utf8('{"x":1}');
  const header = signRequest(A, agentA, 'POST', '/v1/envelopes', body, NOW);
  const auth = parseAuth(header)!;
  assert.equal(auth.callerId, A);
  assert.ok(verifyRequest(auth, b64(agentA.signPub), 'POST', '/v1/envelopes', body, NOW + 1000));
  assert.ok(!verifyRequest(auth, b64(agentA.signPub), 'POST', '/v1/ack', body, NOW));
  assert.ok(!verifyRequest(auth, b64(agentA.signPub), 'POST', '/v1/envelopes', utf8('{}'), NOW));
  assert.ok(!verifyRequest(auth, b64(agentA.signPub), 'POST', '/v1/envelopes', body, NOW + 10 * 60 * 1000));
});

test('statements reject the wrong kind or signer', () => {
  const s = signStatement({ kind: 'pairing', ownerId, issuedAt: NOW }, owner);
  assert.equal(verifyStatement(s, 'pairing', b64(owner.signPub)).ownerId, ownerId);
  assert.throws(() => verifyStatement(s, 'cert', b64(owner.signPub)), /expected a cert/);
  assert.throws(() => verifyStatement(s, 'pairing', b64(agentA.signPub)), /expected key/);
  assert.throws(
    () => verifyStatement({ ...s, payload: { ...s.payload, issuedAt: NOW + 1 } }, 'pairing', b64(owner.signPub)),
    /invalid/,
  );
});
