// Shared end-to-end plumbing: a local relay (wrangler dev + local D1), a proxy in front of it that can play a
// malicious relay, the CLI under test, and owners built from the phone app's client code.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnerClient } from '@catcher/client';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER_DIR = join(ROOT, 'apps/server');
const WRANGLER = join(SERVER_DIR, 'node_modules/.bin/wrangler');
// The CLI under test: the Rust release binary; CATCHER_CLI_BIN overrides it as "program [args...]".
let CLI_PROGRAM = join(ROOT, 'target/release/catcher');
if (process.platform === 'win32') CLI_PROGRAM += '.exe';
let CLI_ARGS: string[] = [];
if (process.env.CATCHER_CLI_BIN) [CLI_PROGRAM = '', ...CLI_ARGS] = process.env.CATCHER_CLI_BIN.trim().split(/\s+/);

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => {
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('no port'));
      });
    });
  });
}

let ipCounter = 0;
/** Local runs share one client IP; a fresh cf-connecting-ip per request keeps the per-IP limits out of the way. */
export function nextIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export interface ProxyCall {
  method: string;
  path: string;
  status: number;
  body: string;
}
/** Return a replacement {status?, body?} to tamper with a relay answer, or nothing to pass it through. */
export type Rewrite = (call: ProxyCall) => Promise<Partial<Pick<ProxyCall, 'status' | 'body'>> | void> | void;

export interface Relay {
  /** direct relay URL */
  direct: string;
  /** proxy URL — what the CLI and owners use */
  server: string;
  work: string;
  /** set to tamper with relay answers (a malicious relay); null passes everything through */
  rewrite: Rewrite | null;
  /** requests the proxy saw (method + path) */
  seen: string[];
  sql(command: string): Record<string, unknown>[];
  scheduled(): Promise<void>;
  stop(): void;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startRelay(): Promise<Relay> {
  const work = mkdtempSync(join(tmpdir(), 'catcher-e2e-'));
  const port = await freePort();
  const direct = `http://127.0.0.1:${port}`;
  const persist = join(work, 'd1');
  const env = { ...process.env, CI: '1' };
  const mig = spawnSync(WRANGLER, ['d1', 'migrations', 'apply', 'catcher', '--local', '--persist-to', persist], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    env,
  });
  assert.equal(mig.status, 0, mig.stderr + mig.stdout);
  const child: ChildProcess = spawn(
    WRANGLER,
    [
      'dev',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      persist,
      '--show-interactive-dev-session=false',
      '--test-scheduled',
      '--var',
      'PUSH_URL:http://127.0.0.1:9/push',
    ],
    { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${direct}/v1/health`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`relay did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 300));
  }

  const relay: Relay = {
    direct,
    server: '',
    work,
    rewrite: null,
    seen: [],
    sql(command) {
      const r = spawnSync(
        WRANGLER,
        ['d1', 'execute', 'catcher', '--local', '--persist-to', persist, '--json', '--command', command],
        { cwd: SERVER_DIR, encoding: 'utf8', env },
      );
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const out = JSON.parse(r.stdout) as { results: Record<string, unknown>[] }[];
      return out.flatMap((o) => o.results);
    },
    async scheduled() {
      const r = await fetch(`${direct}/__scheduled?cron=17+*+*+*+*`);
      assert.ok(r.ok);
    },
    stop() {
      proxy.close();
      proxy.closeAllConnections?.();
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
      rmSync(work, { recursive: true, force: true });
    },
  };

  const proxy = createHttpServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string' && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(k)) {
          headers[k] = v;
        }
      }
      headers['cf-connecting-ip'] ??= nextIp();
      relay.seen.push(`${req.method} ${req.url}`);
      let init: RequestInit = { method: req.method, headers };
      if (body.length) init = { ...init, body: new Uint8Array(body) };
      const upstream = await fetch(direct + req.url, init);
      const call: ProxyCall = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        status: upstream.status,
        body: await upstream.text(),
      };
      const changed = (await relay.rewrite?.(call)) ?? {};
      res.writeHead(changed.status ?? call.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      res.end(changed.body ?? call.body);
    } catch (e) {
      res.writeHead(502);
      res.end(String(e));
    }
  });
  // realtime stream: pipe the WebSocket upgrade straight through
  proxy.on('upgrade', (req, socket, head) => {
    const up = connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  const proxyPort = await freePort();
  await new Promise<void>((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  relay.server = `http://127.0.0.1:${proxyPort}`;
  return relay;
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
  /** last stdout line as JSON */
  json: any;
  /** every stdout line as JSON (NDJSON output) */
  lines: any[];
}

function parseLines(stdout: string): any[] {
  const lines: any[] = [];
  for (const l of stdout.split('\n')) {
    if (!l.trim()) continue;
    try {
      lines.push(JSON.parse(l));
    } catch {
      // text output
    }
  }
  return lines;
}

export function cliEnv(relay: Relay, home: string, server = relay.server): NodeJS.ProcessEnv {
  return { ...process.env, CATCHER_HOME: join(relay.work, home), CATCHER_SERVER: server, CLAUDECODE: '' };
}

/** Run the CLI. Async on purpose: the proxy lives in this process and must keep answering meanwhile. */
export function cli(
  relay: Relay,
  home: string,
  args: string[],
  opts: { server?: string; input?: string } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(CLI_PROGRAM, [...CLI_ARGS, ...args], {
      env: cliEnv(relay, home, opts.server),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(opts.input ?? '');
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = parseLines(out);
      resolve({ code: code ?? -1, out, err, json: lines.at(-1) ?? null, lines });
    });
  });
}

/** A long-running CLI (watch): collect stdout lines as they come. */
export function cliSpawn(relay: Relay, home: string, args: string[]) {
  const child = spawn(CLI_PROGRAM, [...CLI_ARGS, ...args], {
    env: cliEnv(relay, home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const raw: string[] = [];
  let buf = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      raw.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  });
  child.stderr.on('data', (d) => (err += d));
  return {
    child,
    raw,
    stderr: () => err,
    async waitFor(pred: (lines: string[]) => boolean, ms = 30_000): Promise<void> {
      const deadline = Date.now() + ms;
      while (!pred(raw)) {
        if (Date.now() > deadline) throw new Error(`timed out; stdout so far:\n${raw.join('\n')}\nstderr:\n${err}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.on('close', () => resolve());
        child.kill('SIGTERM');
      });
    },
  };
}

/** The phone app's client code, against the proxy, each request from its own client IP. */
export async function newOwner(relay: Relay, fetchImpl?: typeof fetch): Promise<OwnerClient> {
  const f = (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('cf-connecting-ip', nextIp());
    return (fetchImpl ?? fetch)(input, { ...init, headers });
  };
  return new OwnerClient(await OwnerClient.create(relay.server, { fetch: f }), { fetch: f });
}

/** register → owner checks the code and claims → register --wait. Returns the CLI's final JSON. */
export async function enrollAgent(relay: Relay, owner: OwnerClient, home: string, name = home): Promise<any> {
  const reg = await cli(relay, home, ['register', '--name', name, '--json']);
  assert.equal(reg.code, 0, reg.err + reg.out);
  assert.equal(reg.json.status, 'pending');
  const preview = await owner.lookupEnrollment(reg.json.code);
  assert.equal(preview.name, name);
  assert.equal(preview.agentId, reg.json.agentId);
  await owner.claimEnrollment(reg.json.code);
  const done = await cli(relay, home, ['register', '--wait', '--json']);
  assert.equal(done.code, 0, done.err + done.out);
  assert.equal(done.json.status, 'active');
  assert.equal(done.json.ownerFingerprint, owner.fingerprint());
  return done.json;
}
