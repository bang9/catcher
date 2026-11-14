// Relay address chosen before an owner exists (onboarding). After that, the address lives in the owner state.

import { getKv, setKv } from '@/lib/db';
import { DEFAULT_SERVER } from '@/lib/format';

export function chosenServer(): string {
  return getKv('server') ?? DEFAULT_SERVER;
}

export function chooseServer(url: string): void {
  setKv('server', url);
}

/** Is there a catcher relay at this address? */
export async function isCatcherServer(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/health`, { headers: { accept: 'application/json' } });
    if (!res.ok) return false;
    const body = (await res.json()) as { service?: string };
    return body.service === 'catcher';
  } catch {
    return false;
  }
}
