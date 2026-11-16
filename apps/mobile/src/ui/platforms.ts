// Agent platforms the app knows by sight. An agent says where it runs in its registration (`catcher register
// --provider muse`), and the owner can correct it later; a known platform shows its app icon instead of an initial.
// The icons are the platforms' own (App Store / website icons), shown only to say which platform an agent runs on.

import type { ImageSourcePropType } from 'react-native';

export interface Platform {
  id: string;
  /** shown in the app */
  label: string;
  icon: ImageSourcePropType;
}

export const PLATFORMS: Platform[] = [
  { id: 'muse', label: 'Muse', icon: require('../../assets/platforms/muse.png') },
  { id: 'instinct', label: 'Instinct', icon: require('../../assets/platforms/instinct.png') },
  { id: 'pickle', label: 'Pickle', icon: require('../../assets/platforms/pickle.png') },
];

/** Other spellings agents use for the same platform. */
const ALIASES: Record<string, string> = {
  'meta-muse': 'muse',
  'muse-ai': 'muse',
  'instinct-ai': 'instinct',
  'pickle-ai': 'pickle',
};

/** The known platform behind a provider string ("Pickle", "pickle-ai", " MUSE "), or null. */
export function platformOf(provider: string | null | undefined): Platform | null {
  const key = (provider ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  const id = ALIASES[key] ?? key;
  return PLATFORMS.find((p) => p.id === id) ?? null;
}

/** How a provider reads in the app: the platform's own name when it is one we know, otherwise as the agent sent it. */
export function providerLabel(provider: string): string {
  return platformOf(provider)?.label ?? provider;
}

// Rings that tell two agents of the same platform apart (two pickles look the same otherwise). Picked from the agent
// id, so an agent keeps its color everywhere and across phones.
const RINGS = ['#7C5CFF', '#FF8A3D', '#2BB673', '#E5484D', '#2F80ED', '#D6409F', '#C7A008', '#12A5A5'];

export function ringColor(agentId: string): string {
  let h = 0;
  for (let i = 0; i < agentId.length; i += 1) h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  return RINGS[h % RINGS.length] ?? RINGS[0]!;
}
