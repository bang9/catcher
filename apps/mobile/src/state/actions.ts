// Owner decisions that feel instant: the screen updates as soon as the relay accepts the answer, and the sync that
// confirms it runs in the background. (Typed messages: state/rooms.ts sendToRoom.)

import type { AgentSummary, AnswerBody } from '@catcher/protocol';
import type { LocalItem } from '@/lib/db';
import { getState, requireOwner, setState } from './store';
import { syncQuietly, withSeqRetry } from './sync';

function settle(id: string, text: string): void {
  setState({ settled: { ...getState().settled, [id]: text } });
  syncQuietly();
}

function sender(item: LocalItem): AgentSummary {
  const agent = getState().agents.find((a) => a.agentId === item.from);
  if (!agent) throw new Error('requesting agent is gone');
  return agent;
}

/** Answer an ask / confirm / otp. Resolves once the relay has the answer; the list updates right away. */
export async function answerRequest(item: LocalItem, body: AnswerBody, shown: string): Promise<void> {
  const owner = requireOwner();
  await withSeqRetry(() => owner.answer(item, sender(item), body));
  settle(item.id, shown);
}

export async function decideGrant(item: LocalItem, approved: boolean, shown: string): Promise<void> {
  await requireOwner().decideGrantRequest(item, getState().agents, approved);
  settle(item.id, shown);
}

export async function releaseHeld(item: LocalItem, shown: string): Promise<void> {
  await requireOwner().release(item);
  settle(item.id, shown);
}

export async function dropHeld(item: LocalItem, shown: string): Promise<void> {
  await requireOwner().dropHeld(item.id);
  settle(item.id, shown);
}
