// Signed HTTP calls to the catcher relay.

import { AUTH_HEADER, type Identity, signRequest, utf8 } from '@catcher/protocol';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ApiOptions {
  server: string;
  callerId?: string;
  identity?: Pick<Identity, 'signSecret'>;
  fetch?: Fetch;
}

export class Api {
  server: string;
  callerId: string | undefined;
  identity: Pick<Identity, 'signSecret'> | undefined;
  private fetchImpl: Fetch;

  constructor(opts: ApiOptions) {
    this.server = opts.server.replace(/\/+$/, '');
    this.callerId = opts.callerId;
    this.identity = opts.identity;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
    let raw: Uint8Array = new Uint8Array();
    if (body !== undefined) raw = utf8(JSON.stringify(body));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false) {
      if (!this.callerId || !this.identity) throw new ApiError(0, 'no_identity', 'not registered yet');
      headers[AUTH_HEADER] = signRequest(this.callerId, this.identity, method, path, raw);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.server + path, {
        method,
        headers,
        body: bodyInit(body, raw),
      });
    } catch (e) {
      throw new ApiError(0, 'network', `cannot reach ${this.server}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      if (text) data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(
        res.status,
        err?.code ?? `http_${res.status}`,
        err?.message ?? (text.slice(0, 200) || res.statusText),
      );
    }
    return data as T;
  }
}

function bodyInit(body: unknown, raw: Uint8Array): BodyInit | undefined {
  if (body === undefined) return undefined;
  return raw as unknown as BodyInit;
}
