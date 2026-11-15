// catcher relay — router.

import * as enroll from './enroll.ts';
import * as h from './handlers.ts';
import { authenticate, type Env, errorResponse, HttpError, json } from './http.ts';

export { Hub } from './hub.ts';

interface Ctx {
  env: Env;
  req: Request;
  url: URL;
  body: Uint8Array;
  params: string[];
  exec: ExecutionContext;
}
type Handler = (ctx: Ctx) => Promise<Response>;
type Caller = Awaited<ReturnType<typeof authenticate>>;

const authed =
  (fn: (ctx: Ctx, caller: Caller) => Promise<Response>): Handler =>
  async (ctx) => {
    const caller = await authenticate(ctx.env, ctx.req, ctx.url.pathname + ctx.url.search, ctx.body);
    if (caller.kind === 'agent' && caller.lastSeenAt === null) {
      ctx.exec.waitUntil(
        enroll.agentFirstSeen(ctx.env, caller.id).catch((err) => console.warn('first seen failed', err)),
      );
    }
    return fn(ctx, caller);
  };

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/v1\/health$/, async () => json({ ok: true, service: 'catcher', protocol: 1 })],
  ['POST', /^\/v1\/owners$/, async ({ env, req, body }) => h.createOwner(env, req, body)],
  ['GET', /^\/v1\/owners\/lookup$/, async ({ env, url }) => h.lookupOwner(env, url)],
  ['POST', /^\/v1\/owner\/keys$/, authed(({ env, body, exec }, c) => h.appendOwnerKey(env, c, body, exec))],
  ['POST', /^\/v1\/owner\/push-tokens$/, authed(({ env, body }, c) => h.putPushToken(env, c, body))],
  ['POST', /^\/v1\/owner\/push-tokens\/delete$/, authed(({ env, body }, c) => h.deletePushToken(env, c, body))],
  ['GET', /^\/v1\/owner\/agents$/, authed(({ env }, c) => h.listAgents(env, c))],
  [
    'GET',
    /^\/v1\/owner\/enrollments\/([0-9A-Z]{5})$/,
    authed(({ env, params }, c) => enroll.ownerEnrollment(env, c, params[0]!)),
  ],
  [
    'POST',
    /^\/v1\/owner\/enrollments\/([0-9A-Z]{5})\/claim$/,
    authed(({ env, params, body, exec }, c) => enroll.claimEnrollment(env, c, params[0]!, body, exec)),
  ],
  ['POST', /^\/v1\/owner\/certs$/, authed(({ env, body, exec }, c) => h.postCert(env, c, body, exec))],
  ['POST', /^\/v1\/owner\/grants$/, authed(({ env, body, exec }, c) => h.postGrant(env, c, body, exec))],
  ['POST', /^\/v1\/owner\/revocations$/, authed(({ env, body, exec }, c) => h.postRevocations(env, c, body, exec))],
  ['POST', /^\/v1\/owner\/releases$/, authed(({ env, body, exec }, c) => h.postRelease(env, c, body, exec))],
  ['POST', /^\/v1\/owner\/held\/(m_[0-9a-z]+)\/drop$/, authed(({ env, params }, c) => h.dropHeld(env, c, params[0]!))],
  ['GET', /^\/v1\/owner\/feed$/, authed(({ env, url, exec }, c) => h.ownerFeed(env, c, url, exec))],
  ['GET', /^\/v1\/owner\/envelopes$/, authed(({ env, url }, c) => h.envelopeStates(env, c, url))],
  ['POST', /^\/v1\/enroll$/, async ({ env, req, body, exec }) => enroll.enroll(env, req, body, exec)],
  [
    'GET',
    /^\/v1\/enroll\/([0-9A-Z]{5})$/,
    async ({ env, req, url, params }) => enroll.enrollStatus(env, req, url, params[0]!),
  ],
  // 0.1 pairing flow
  ['POST', /^\/v1\/register$/, async () => enroll.gone()],
  ['POST', /^\/v1\/owner\/pairings$/, async () => enroll.gone()],
  ['POST', /^\/v1\/owner\/agents\/a_[0-9a-z]+\/reject$/, async () => enroll.gone()],
  ['GET', /^\/v1\/me$/, authed(({ env }, c) => h.me(env, c))],
  ['GET', /^\/v1\/directory$/, authed(({ env, url }, c) => h.directory(env, c, url))],
  ['GET', /^\/v1\/inbox$/, authed(({ env, url, exec }, c) => h.inbox(env, c, url, exec))],
  ['POST', /^\/v1\/ack$/, authed(({ env, body }, c) => h.ack(env, c, body))],
  ['GET', /^\/v1\/replies$/, authed(({ env, url }, c) => h.replies(env, c, url))],
  ['POST', /^\/v1\/envelopes$/, authed(({ env, body, exec }, c) => h.postEnvelope(env, c, body, exec))],
];

const MAX_BODY = 256 * 1024;

/** Realtime: GET /v1/stream?auth=<signed GET /v1/stream> upgrades to a WebSocket on the owner's hub. */
async function stream(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.headers.get('upgrade') !== 'websocket') throw new HttpError(426, 'upgrade_required', 'use a WebSocket');
  const caller = await authenticate(env, req, '/v1/stream', new Uint8Array(), url.searchParams.get('auth'));
  if (caller.kind === 'agent' && caller.status !== 'active')
    throw new HttpError(403, 'not_active', 'agent is not active');
  const stub = env.HUB.get(env.HUB.idFromName(caller.ownerId));
  const headers = new Headers(req.headers);
  headers.set('x-catcher-listener', caller.id);
  return stub.fetch(new Request('https://hub/stream', { headers }));
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.pathname === '/v1/stream' && req.method === 'GET') return await stream(req, env, url);
      const match = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!match) {
        if (url.pathname === '/' && req.method === 'GET') {
          return new Response('catcher — agent bridge. https://github.com/bang9/catcher\n', {
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
        throw new HttpError(404, 'not_found', 'no such endpoint');
      }
      const body = new Uint8Array(await req.arrayBuffer());
      if (body.length > MAX_BODY) throw new HttpError(413, 'too_large', 'request body is too large');
      const params = match[1].exec(url.pathname)!.slice(1);
      return await match[2]({ env, req, url, body, params, exec });
    } catch (e) {
      return errorResponse(e);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    exec.waitUntil(h.cleanup(env));
  },
} satisfies ExportedHandler<Env>;
