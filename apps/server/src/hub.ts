// Realtime hub — one Durable Object per owner. Agents and the owner app hold a hibernating WebSocket here and get a
// tiny "something new for you" signal; they then read the mailbox over the normal API. No content passes through.
// Hibernation keeps idle sockets free: the object only wakes to fan out a signal.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './http.ts';

export interface HubSignal {
  /** recipient id — the owner listens to everything of its own */
  to: string;
  kind: 'envelope' | 'registration' | 'directory';
  cursor?: number;
  id?: string;
}

export class Hub extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/notify') {
      const incoming = (await req.json()) as HubSignal & { ownerId: string };
      const text = JSON.stringify({ t: incoming.kind, cursor: incoming.cursor ?? null, id: incoming.id ?? null });
      let targets = new Set([...this.ctx.getWebSockets(incoming.to), ...this.ctx.getWebSockets(incoming.ownerId)]);
      // directory changes (certs, grants, revocations, owner key) go to everyone
      if (incoming.to === '*') targets = new Set(this.ctx.getWebSockets());
      for (const ws of targets) {
        try {
          ws.send(text);
        } catch {
          // closed socket — the runtime drops it
        }
      }
      return new Response(null, { status: 204 });
    }
    const listener = req.headers.get('x-catcher-listener');
    if (!listener || req.headers.get('upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [listener]);
    server.send(JSON.stringify({ t: 'hello' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === 'ping') ws.send('pong');
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, 'bye');
    } catch {
      // already closed
    }
  }
}

/** Fire-and-forget signal to listeners of `ownerId`. */
export async function signal(env: Env, ownerId: string, s: HubSignal): Promise<void> {
  if (!env.HUB) return;
  const stub = env.HUB.get(env.HUB.idFromName(ownerId));
  await stub.fetch('https://hub/notify', { method: 'POST', body: JSON.stringify({ ...s, ownerId }) });
}
