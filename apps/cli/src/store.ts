// Local files — everything an agent keeps lives under CATCHER_HOME (default ~/.catcher), one folder per profile,
// readable only by the user: state (secret seed), the verified-directory cache, and the message history.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentState, DirectoryCache, Received } from '@catcher/client';
import type { Directory } from '@catcher/protocol';

export const DEFAULT_SERVER = 'https://catcher.bang9.dev';

export function catcherHome(): string {
  return process.env.CATCHER_HOME || join(homedir(), '.catcher');
}

export function profileDir(profile: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) throw new Error('profile must be lowercase letters, digits, - or _');
  return join(catcherHome(), 'profiles', profile);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** write-then-rename so a crash never leaves half a state file */
function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export class Profile {
  name: string;
  dir: string;

  constructor(name: string) {
    this.name = name;
    this.dir = profileDir(name);
  }

  get statePath(): string {
    return join(this.dir, 'state.json');
  }

  exists(): boolean {
    return existsSync(this.statePath);
  }

  load(): AgentState {
    if (!this.exists()) {
      throw Object.assign(
        new Error(`no agent in profile "${this.name}" — run: catcher register --code <code> --name <name>`),
        {
          exitCode: 6,
        },
      );
    }
    return JSON.parse(readFileSync(this.statePath, 'utf8')) as AgentState;
  }

  save(state: AgentState): void {
    ensureDir(this.dir);
    writePrivate(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  directoryCache(): DirectoryCache {
    const path = join(this.dir, 'directory.json');
    return {
      load: () => {
        if (!existsSync(path)) return null;
        try {
          return JSON.parse(readFileSync(path, 'utf8')) as { version: number; directory: Directory };
        } catch {
          return null;
        }
      },
      save: (entry) => {
        ensureDir(this.dir);
        writePrivate(path, JSON.stringify(entry));
      },
    };
  }

  get historyPath(): string {
    return join(this.dir, 'history.jsonl');
  }

  /** Decrypted history — the relay deletes delivered messages, so this file is the agent's record. */
  record(entry: HistoryEntry): void {
    ensureDir(this.dir);
    appendFileSync(this.historyPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** Ids this agent acked — the relay serving one again is a replay. */
  markAcked(ids: string[]): void {
    if (!ids.length) return;
    ensureDir(this.dir);
    appendFileSync(join(this.dir, 'acked.txt'), `${ids.join('\n')}\n`, { mode: 0o600 });
  }

  ackedIds(): Set<string> {
    const path = join(this.dir, 'acked.txt');
    if (!existsSync(path)) return new Set();
    return new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean));
  }

  history(): HistoryEntry[] {
    if (!existsSync(this.historyPath)) return [];
    const out: HistoryEntry[] = [];
    for (const line of readFileSync(this.historyPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as HistoryEntry);
      } catch {
        // skip a torn line
      }
    }
    return out;
  }
}

export interface HistoryEntry {
  direction: 'in' | 'out';
  id: string;
  type: string;
  /** names, for people */
  from: string;
  to: string;
  /** ids, for matching replies and answers */
  fromId?: string;
  toId?: string;
  grantId?: string | null;
  ref: string | null;
  scope: string | null;
  at: number;
  body: unknown;
}

/** `redact` keeps one-time codes off the disk once they have been handed over. */
export function historyFromReceived(r: Received, redact = false): HistoryEntry {
  let body = r.body;
  if (redact) body = { code: '[delivered]' };
  return {
    direction: 'in',
    id: r.id,
    type: r.type,
    from: r.from.name,
    to: r.to,
    fromId: r.from.id,
    toId: r.to,
    grantId: r.grantId,
    ref: r.ref,
    scope: r.scope,
    at: r.createdAt,
    body,
  };
}
