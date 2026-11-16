// An agent's name is a nickname the owner picks and can change; an agent whose machine was reset can be connected as
// the continuation of the old one (grants move over); a disconnected agent can be taken off the owner's lists.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ApiError, EnrollmentError } from '@catcher/client';
import { cli, enrollAgent, newOwner, type Relay, startRelay } from './harness.ts';

let relay: Relay;

before(async () => {
  relay = await startRelay();
});

after(() => relay?.stop());

async function register(home: string, name = home, extra: string[] = []): Promise<any> {
  const r = await cli(relay, home, ['register', '--name', name, '--json', ...extra]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json.status, 'pending');
  return r.json;
}

function messages(r: { lines: any[] }): any[] {
  return r.lines.filter((l) => l.t === 'message');
}

test('the owner names the agent at approval; the agent takes that name', async () => {
  const owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'pickle-a', 'pickle');
  const reg = await register('pickle-b', 'pickle', ['--provider', 'pickle']);
  const preview = await owner.lookupEnrollment(reg.code);
  assert.equal(preview.provider, 'pickle');
  // the agent's own name is taken: the code stays open for another name
  await assert.rejects(
    () => owner.claimEnrollment(reg.code),
    (e) => e instanceof ApiError && e.code === 'name_taken',
  );
  await assert.rejects(
    () => owner.claimEnrollment(reg.code, { name: 'Not A Name' }),
    (e) => e instanceof EnrollmentError && e.code === 'bad_name',
  );
  const claimed = await owner.claimEnrollment(reg.code, { name: 'pickle-2' });
  assert.equal(claimed.name, 'pickle-2');
  const done = await cli(relay, 'pickle-b', ['register', '--wait', '--json']);
  assert.equal(done.code, 0, done.err);
  assert.equal(done.json.name, 'pickle-2');
  const { agents } = await owner.agents();
  assert.deepEqual(agents.map((a) => a.name).sort(), ['pickle', 'pickle-2']);
});

test('rename: a new cert; other agents reach it by the new name, and it knows its own', async () => {
  const owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'ren-a', 'scout');
  await enrollAgent(relay, owner, 'ren-b', 'keeper');
  const { agents } = await owner.agents();
  const scout = agents.find((a) => a.name === 'scout')!;
  const keeper = agents.find((a) => a.name === 'keeper')!;
  await owner.grant({ from: keeper.agentId, to: scout.agentId, scopes: ['message'] });

  // a live name is refused; a free one goes through, with the platform corrected too
  await assert.rejects(
    () => owner.updateAgent(scout.agentId, { name: 'keeper' }),
    (e) => e instanceof ApiError && e.code === 'name_taken',
  );
  await owner.updateAgent(scout.agentId, { name: 'ranger', provider: 'instinct' });
  const renamed = (await owner.agents()).agents.find((a) => a.agentId === scout.agentId)!;
  assert.equal(renamed.name, 'ranger');
  assert.equal(renamed.provider, 'instinct');
  assert.equal(renamed.cert?.payload.name, 'ranger');

  const sent = await cli(relay, 'ren-b', ['send', 'ranger', 'hello ranger', '--json']);
  assert.equal(sent.code, 0, sent.err);
  const oldName = await cli(relay, 'ren-b', ['send', 'scout', 'hi']);
  assert.equal(oldName.code, 7);
  assert.match(oldName.err, /no certified agent named scout/);
  const inbox = await cli(relay, 'ren-a', ['inbox', '--json']);
  assert.equal(messages(inbox).find((m) => m.id === sent.json.id)?.body.text, 'hello ranger');
  // the agent follows its owner's name (an old setup script re-running register with the old name is fine)
  const again = await cli(relay, 'ren-a', ['register', '--name', 'scout', '--json']);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.name, 'ranger');
  assert.match(again.err, /already registered as ranger/);
});

test("continue: a reset agent takes the old one's place, name and grants", async () => {
  const owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'cont-old', 'instinct');
  await enrollAgent(relay, owner, 'cont-peer', 'peer');
  const start = (await owner.agents()).agents;
  const oldId = start.find((a) => a.name === 'instinct')!.agentId;
  const peerId = start.find((a) => a.name === 'peer')!.agentId;
  await owner.grant({ from: oldId, to: peerId, scopes: ['message', 'calendar.read'], requireApproval: false });
  await owner.grant({ from: peerId, to: oldId, scopes: ['message'], expiresAt: Date.now() + 86_400_000 });

  // the VM is gone: same agent, new profile, new key, new id
  const reg = await register('cont-new', 'instinct');
  const preview = await owner.lookupEnrollment(reg.code);
  assert.equal(preview.existing?.agentId, oldId);
  // continuing never takes the relay's word for which agent is yours
  await assert.rejects(
    () => owner.claimEnrollment(reg.code, { continues: 'a_notmineatall' }),
    (e) => e instanceof EnrollmentError && e.code === 'nothing_to_replace',
  );
  assert.equal((await owner.agents()).agents.find((a) => a.agentId === oldId)!.status, 'active');

  const claimed = await owner.claimEnrollment(reg.code, { continues: oldId });
  assert.equal(claimed.name, 'instinct');
  assert.equal(await owner.continueGrants(oldId, claimed.agentId), 2);
  // running it again issues nothing twice
  assert.equal(await owner.continueGrants(oldId, claimed.agentId), 0);

  const { agents } = await owner.agents();
  assert.equal(agents.find((a) => a.agentId === oldId)!.status, 'revoked');
  const fresh = agents.find((a) => a.agentId === claimed.agentId)!;
  assert.equal(fresh.cert?.payload.continues, oldId);
  assert.equal(fresh.name, 'instinct');

  const done = await cli(relay, 'cont-new', ['register', '--wait', '--json']);
  assert.equal(done.code, 0, done.err);
  // the grants moved: scopes, direction and expiry as before
  const sent = await cli(relay, 'cont-new', ['send', 'peer', 'what is on the calendar?', '--scope', 'calendar.read']);
  assert.equal(sent.code, 0, sent.err);
  const back = await cli(relay, 'cont-peer', ['send', 'instinct', 'welcome back']);
  assert.equal(back.code, 0, back.err);
  assert.equal((await cli(relay, 'cont-old', ['inbox'])).code, 6);
});

test('continue an agent that was already disconnected', async () => {
  const owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'gone-old', 'muse');
  const oldId = (await owner.agents()).agents.find((a) => a.name === 'muse')!.agentId;
  await owner.revoke({ agents: [oldId] });
  const reg = await register('gone-new', 'muse-vm');
  await owner.lookupEnrollment(reg.code);
  const claimed = await owner.claimEnrollment(reg.code, { continues: oldId });
  // takes the old agent's name unless the owner gives another
  assert.equal(claimed.name, 'muse');
  const done = await cli(relay, 'gone-new', ['register', '--wait', '--json']);
  assert.equal(done.json.name, 'muse');
});

test('remove: only a disconnected agent, and it stays known', async () => {
  const owner = await newOwner(relay);
  await enrollAgent(relay, owner, 'rm-a', 'temp');
  const id = (await owner.agents()).agents.find((a) => a.name === 'temp')!.agentId;
  await assert.rejects(
    () => owner.removeAgent(id),
    (e) => e instanceof ApiError && e.code === 'agent_active',
  );
  await owner.revoke({ agents: [id] });
  await owner.removeAgent(id);
  const row = (await owner.agents()).agents.find((a) => a.agentId === id)!;
  assert.equal(row.status, 'revoked');
  assert.ok(row.removedAt);
  // another owner cannot touch it
  const stranger = await newOwner(relay);
  await assert.rejects(
    () => stranger.removeAgent(id),
    (e) => e instanceof ApiError && e.status === 404,
  );
});
