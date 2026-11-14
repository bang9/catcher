// Realtime: while the app is in the foreground, hold the owner's WebSocket on the relay hub. The hub sends only
// "something changed" signals ({t: envelope|registration|directory}); each one triggers a normal sync.
// The stream URL is signed fresh on every connect (signatures are valid for 5 minutes).

import { AppState, type AppStateStatus } from 'react-native';
import { signRequest } from '@catcher/protocol';
import { getState, setState } from './store';
import { syncQuietly } from './sync';

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

let socket: WebSocket | null = null;
let ping: ReturnType<typeof setInterval> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;
let wanted = false;

function streamUrl(): string | null {
  const owner = getState().owner;
  if (!owner) return null;
  const auth = signRequest(owner.state.ownerId, owner.identity, 'GET', '/v1/stream', new Uint8Array());
  const base = owner.state.server.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${base}/v1/stream?auth=${encodeURIComponent(auth)}`;
}

function clearTimers(): void {
  if (ping) clearInterval(ping);
  ping = null;
  if (retry) clearTimeout(retry);
  retry = null;
}

function connect(): void {
  if (!wanted || socket) return;
  const url = streamUrl();
  if (!url) return;
  setState({ live: 'connecting' });
  const ws = new WebSocket(url);
  socket = ws;
  ws.addEventListener('open', () => {
    backoff = 1000;
    setState({ live: 'live' });
    ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, PING_MS);
  });
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || event.data === 'pong') return;
    let t: unknown = null;
    try {
      t = (JSON.parse(event.data) as { t?: unknown }).t;
    } catch {
      return;
    }
    // hello: (re)connected, catch up on anything missed while offline
    if (t === 'hello' || t === 'envelope' || t === 'registration' || t === 'directory') syncQuietly();
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    clearTimers();
    if (!wanted) {
      setState({ live: 'off' });
      return;
    }
    setState({ live: 'connecting' });
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  });
}

export function startRealtime(): void {
  wanted = true;
  connect();
}

export function stopRealtime(): void {
  wanted = false;
  clearTimers();
  const ws = socket;
  socket = null;
  ws?.close();
  setState({ live: 'off' });
}

/** After a key rotation or server change: drop the socket signed with old credentials. */
export function restartRealtime(): void {
  stopRealtime();
  startRealtime();
}

/** Foreground: connect and sync. Background: close (push takes over). Returns an unsubscribe. */
function onAppState(next: AppStateStatus): void {
  if (next === 'active') {
    startRealtime();
    syncQuietly();
    return;
  }
  if (next === 'background') stopRealtime();
}

export function followAppState(): () => void {
  // currentState can be 'unknown' at launch; anything but background counts as foreground
  if (AppState.currentState !== 'background') onAppState('active');
  const sub = AppState.addEventListener('change', onAppState);
  return () => {
    sub.remove();
    stopRealtime();
  };
}
