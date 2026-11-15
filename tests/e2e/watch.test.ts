// The message channel: `watch --json` / `inbox --json` print one JSON line per message, explicit ack, at-least-once.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { OwnerClient } from '@catcher/client';
import type { AgentSummary } from '@catcher/protocol';
import { cli, cliSpawn, enrollAgent, newOwner, type Relay, startRelay } from './harness.ts';

let relay: Relay;
let owner: OwnerClient;
let agent: AgentSummary;

before(async () => {
  relay = await startRelay();
  owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'w');
  agent = (await owner.agents()).agents.find((a) => a.name === 'w')!;
});

after(() => relay?.stop());

const parsed = (raw: string[]) => raw.map((l) => JSON.parse(l));
const idsIn = (raw: string[]) => parsed(raw).map((l) => l.id);

const tricky = 'two\nlines and more "quoted" \\ </x>';
let first = '';
let second = '';
let third = '';

test('watch --json: one line per message, line breaks escaped, nothing printed twice in a run', async () => {
  const watch = cliSpawn(relay, 'w', ['watch', '--json', '--interval', '1s']);
  try {
    first = await owner.send('message', agent, { text: tricky });
    second = await owner.send('message', agent, { text: 'second', data: { n: 2 } });
    await watch.waitFor((raw) => raw.length >= 2);
    third = await owner.send('message', agent, { text: 'third' });
    await watch.waitFor((raw) => idsIn(raw).includes(third));
    // a few more drains (stream signals and the 1 s poll) must not print anything again
    await new Promise((r) => setTimeout(r, 2500));
    assert.deepEqual(idsIn(watch.raw), [first, second, third]);
    for (const raw of watch.raw) {
      assert.ok(!raw.includes(' ') && !raw.includes(' '), 'U+2028/2029 are escaped');
    }
    const [a, b] = parsed(watch.raw);
    assert.equal(a.v, 1);
    assert.equal(a.t, 'message');
    assert.equal(a.type, 'message');
    assert.deepEqual(a.from, { kind: 'owner', id: owner.state.ownerId, name: 'owner' });
    assert.equal(a.to, agent.agentId);
    assert.equal(a.grant, null);
    assert.equal(a.redelivered, false);
    assert.deepEqual(a.body, { text: tricky, data: null });
    assert.deepEqual(Object.keys(a), [
      'v',
      't',
      'id',
      'type',
      'from',
      'to',
      'ref',
      'scope',
      'grant',
      'createdAt',
      'expiresAt',
      'redelivered',
      'relay',
      'body',
    ]);
    assert.ok(Number.isSafeInteger(a.relay.cursor) && Number.isSafeInteger(a.relay.receivedAt));
    assert.deepEqual(b.body, { text: 'second', data: { n: 2 } });
  } finally {
    await watch.stop();
  }
});

test('after a restart unacked messages come again as redelivered; an ack from another process stops that', async () => {
  const acked = await cli(relay, 'w', ['ack', second]);
  assert.equal(acked.code, 0, acked.err);
  const again = await cli(relay, 'w', ['watch', '--once', '--json']);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(
    again.lines.map((l) => [l.id, l.redelivered]),
    [
      [first, true],
      [third, true],
    ],
  );
  await cli(relay, 'w', ['ack', first, third]);
  const empty = await cli(relay, 'w', ['watch', '--once', '--json']);
  assert.equal(empty.out, '');
});

test('a request sent from another process while watch runs: its answer arrives and wait still works', async () => {
  const watch = cliSpawn(relay, 'w', ['watch', '--json', '--interval', '1s']);
  try {
    // let watch start before the request exists
    await new Promise((r) => setTimeout(r, 500));
    const ask = await cli(relay, 'w', ['ask', 'ship it?', '--json']);
    assert.equal(ask.code, 0, ask.err);
    const feed = await owner.feed(0, 500);
    const items = owner.openItems(feed.envelopes, (await owner.agents()).agents, await owner.ownerSignKeys());
    const request = items.find((i) => i.id === ask.json.id)!;
    await owner.answer(request, agent, { answer: 'yes' });
    await watch.waitFor((raw) => parsed(raw).some((l) => l.ref === ask.json.id));
    const line = parsed(watch.raw).find((l) => l.ref === ask.json.id);
    assert.equal(line.t, 'message');
    assert.equal(line.type, 'answer');
    assert.equal(line.from.kind, 'owner');
    assert.deepEqual(line.body, { answer: 'yes' });
    const waited = await cli(relay, 'w', ['wait', ask.json.id, '--timeout', '10s']);
    assert.equal(waited.code, 0, waited.err);
    assert.equal(waited.out.trim(), 'yes');
  } finally {
    await watch.stop();
  }
});

test('a message that fails verification is a rejected line with no content, and it is acked', async () => {
  const id = await owner.send('message', agent, { text: 'secret content' });
  let row: unknown = null;
  relay.rewrite = async (call) => {
    if (!call.path.startsWith('/v1/inbox')) return;
    const data = JSON.parse(call.body);
    const found = data.envelopes.find((e: { envelope: { core: { id: string } } }) => e.envelope.core.id === id);
    if (found) row = found;
  };
  try {
    const got = await cli(relay, 'w', ['inbox', '--json', '--ack']);
    assert.equal(got.code, 0, got.err);
    assert.ok(got.lines.some((l) => l.id === id));
  } finally {
    relay.rewrite = null;
  }
  assert.ok(row);
  // the relay replays the acked message
  relay.rewrite = async (call) => {
    if (!call.path.startsWith('/v1/inbox')) return;
    const data = JSON.parse(call.body);
    data.envelopes.push(row);
    return { body: JSON.stringify(data) };
  };
  const seenBefore = relay.seen.length;
  try {
    const replay = await cli(relay, 'w', ['inbox', '--json']);
    assert.equal(replay.code, 0, replay.err);
    assert.deepEqual(replay.lines, [{ t: 'rejected', id, code: 'replay' }]);
    assert.ok(!replay.out.includes('secret content'));
    assert.ok(relay.seen.slice(seenBefore).some((r) => r.startsWith('POST /v1/ack')));
  } finally {
    relay.rewrite = null;
  }
});

test('an OTP answered while watch runs: the code is on the channel line, wait then says it was handed over', async () => {
  const watch = cliSpawn(relay, 'w', ['watch', '--json', '--interval', '1s']);
  try {
    await new Promise((r) => setTimeout(r, 500));
    const otp = await cli(relay, 'w', ['otp', '--for', 'bank', '--json']);
    assert.equal(otp.code, 0, otp.err);
    const feed = await owner.feed(0, 500);
    const items = owner.openItems(feed.envelopes, (await owner.agents()).agents, await owner.ownerSignKeys());
    await owner.answer(
      items.find((i) => i.id === otp.json.id)!,
      agent,
      { code: '123456' },
    );
    await watch.waitFor((raw) => parsed(raw).some((l) => l.ref === otp.json.id));
    assert.deepEqual(parsed(watch.raw).find((l) => l.ref === otp.json.id).body, { code: '123456' });
    const waited = await cli(relay, 'w', ['wait', otp.json.id, '--timeout', '5s']);
    assert.equal(waited.code, 7);
    assert.match(waited.out, /already handed over/);
  } finally {
    await watch.stop();
  }
});

test('inbox --json pages past messages still waiting for an ack', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push(await owner.send('message', agent, { text: `page ${i}` }));
  const got = await cli(relay, 'w', ['inbox', '--json', '--limit', '2']);
  assert.equal(got.code, 0, got.err);
  const seen = got.lines.filter((l) => l.t === 'message').map((l) => l.id);
  for (const id of ids) assert.ok(seen.includes(id), id);
  await cli(relay, 'w', ['ack', ...seen]);
});
