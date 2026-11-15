// Agent-first registration against the frozen vectors in vectors.json (the Rust CLI checks the same file).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  agentIdFor,
  b64,
  canonical,
  claimAad,
  claimKey,
  EnrollCodeError,
  enrollCode,
  enrollParts,
  enrollTag,
  hex,
  identityFromSeed,
  openClaim,
  parseEnrollCode,
  resolveOwnerKeys,
  sealClaim,
  sharedSecret,
  type Signed,
  signEnroll,
  tagMatches,
  unb64,
  utf8,
  verifyEnroll,
  boxPublic,
} from '../src/index.ts';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const fill = (n: number) => identityFromSeed(new Uint8Array(32).fill(n));
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const stream = (...parts: Uint8Array[]) => {
  const queue = [...parts];
  return (len: number) => {
    const next = queue.shift();
    assert.ok(next && next.length === len, 'random stream order');
    return next;
  };
};
const agent = fill(V.identities.agent.seedFill);
const owner = fill(V.identities.owner.seedFill);
const me = { ...agent, ...V.claimContext };

test('identities and agent ids', () => {
  for (const name of Object.keys(V.identities)) {
    const id = fill(V.identities[name].seedFill);
    assert.equal(b64(id.signPub), V.identities[name].signPub);
    assert.equal(b64(id.boxPub), V.identities[name].boxPub);
  }
  for (const v of V.agentIds) {
    assert.equal(agentIdFor(v.signPub), v.agentId);
    assert.match(v.agentId, /^a_[0-9a-z]{16}$/);
  }
});

test('code: fixed random bytes → lookup, secret, tag, check, code', () => {
  for (const v of V.codes) {
    const { lookup, secret } = enrollParts(unhex(v.random));
    assert.equal(hex(unhex(v.random)), v.random);
    assert.deepEqual(enrollCode(lookup, secret, { signPub: v.signPub, boxPub: v.boxPub }), {
      lookup: v.lookup,
      secret: v.secret,
      tag: v.tag,
      check: v.check,
      code: v.code,
    });
  }
});

test('tag changes with every input', () => {
  const b = V.tagVariants.base;
  assert.equal(enrollTag(b.lookup, b.secret, { signPub: b.signPub, boxPub: b.boxPub }), b.tag);
  for (const v of V.tagVariants.variants) {
    const i = { ...b, [v.field]: v.value };
    const tag = enrollTag(i.lookup, i.secret, { signPub: i.signPub, boxPub: i.boxPub });
    assert.equal(tag, v.tag);
    assert.notEqual(tag, b.tag, v.field);
  }
});

test('parsing: case, spaces, dashes, O/I/L, links; wrong length, characters and check', () => {
  for (const p of V.parse) {
    if (p.ok) {
      assert.deepEqual(parseEnrollCode(p.input), p.ok, p.input);
    } else {
      assert.throws(
        () => parseEnrollCode(p.input),
        (e: unknown) => e instanceof EnrollCodeError && e.code === p.error,
        p.input,
      );
    }
  }
});

test('enroll statement: canonical bytes and signature', () => {
  const s = V.enroll.statement;
  const p = s.payload;
  assert.equal(canonical({ ctx: 'catcher/v1/statement', payload: p }), V.enroll.canonical);
  const again = signEnroll(
    { lookup: p.lookup, name: p.name, device: p.device, provider: p.provider, issuedAt: p.issuedAt },
    agent,
  );
  assert.deepEqual(again, s);
  assert.deepEqual(verifyEnroll(s, p.lookup), p);
  assert.throws(() => verifyEnroll(s, '00000'), /another code/);
  // signed by someone else than the key it registers
  const forged = { ...s, signer: V.identities.other.signPub };
  assert.throws(() => verifyEnroll(forged, p.lookup));
  const renamed = signEnroll({ ...p, name: 'owner' }, agent);
  assert.throws(() => verifyEnroll(renamed, p.lookup), /bad name/);
  const parsed = parseEnrollCode(V.codes[3].code);
  assert.ok(tagMatches(parsed, p));
  assert.ok(!tagMatches(parsed, { signPub: V.identities.other.signPub, boxPub: p.boxPub }));
});

test('claim with a fixed ephemeral key and nonce: aad, key, sealed secret, signature', () => {
  const c = V.claim;
  const claim = sealClaim({
    owner,
    ownerId: V.identities.owner.ownerId,
    lookup: me.lookup,
    secret: me.secret,
    agentId: me.agentId,
    agentSignPub: b64(agent.signPub),
    agentBoxPub: b64(agent.boxPub),
    issuedAt: V.now,
    random: stream(unhex(c.ephSecret), unhex(c.nonce)),
  });
  assert.deepEqual(claim, c.statement);
  assert.equal(new TextDecoder().decode(claimAad(claim.payload)), c.aad);
  const eph = unhex(c.ephSecret);
  assert.equal(b64(claimKey(sharedSecret(eph, agent.boxPub), boxPublic(eph), agent.boxPub)), c.kek);
  const opened = openClaim(c.statement, me);
  assert.equal(opened.ownerSignPub, V.identities.owner.signPub);
  assert.equal(opened.ownerId, V.identities.owner.ownerId);
});

test('claim negatives: the agent trusts none of them', () => {
  for (const n of V.claimNegatives) {
    assert.throws(() => openClaim(n.claim as Signed, me), Error, n.name);
  }
  // the agent's own secret is what decides: the same claim opened with another secret fails
  assert.throws(() => openClaim(V.claim.statement, { ...me, secret: 'ZZZZZ' }));
  assert.equal(unb64(V.claim.statement.payload.nonce).length, 24);
  assert.equal(utf8(me.secret).length, 5);
});

test('rotation: the key that signed the claim walks forward along the signed chain', () => {
  const r = V.rotation;
  assert.deepEqual(resolveOwnerKeys(r.chain, r.ownerId, r.pinned), r.current);
});
