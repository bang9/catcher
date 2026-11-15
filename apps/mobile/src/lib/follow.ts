// Following the bottom of a chat (the same rules as the allob app's chat). Looking at the latest message: new ones stick
// to the bottom. Scrolled up to read: the list stays put and a "↓ New" button shows instead. Pure, no UI.

export interface Follow {
  /** looking at the bottom (latest) right now */
  atEnd: boolean;
  /** something new arrived since leaving the bottom */
  unseen: boolean;
  /** a mark of the latest content seen — a different mark means something new */
  mark: string;
}

export function startFollow(mark: string): Follow {
  return { atEnd: true, unseen: false, mark };
}

/** The list reached or left the bottom — reaching it means the new content was seen. */
export function scrolled(f: Follow, atEnd: boolean): Follow {
  if (atEnd === f.atEnd) return f;
  if (atEnd) return { ...f, atEnd, unseen: false };
  return { ...f, atEnd };
}

/** The latest content changed: at the bottom it just follows; scrolled up, it is marked as unseen. */
export function contentChanged(f: Follow, mark: string): Follow {
  if (mark === f.mark) return f;
  return { ...f, mark, unseen: f.unseen || !f.atEnd };
}

/** The owner sent something: back to the bottom wherever they were (the caller scrolls the list). */
export function sent(mark: string): Follow {
  return { atEnd: true, unseen: false, mark };
}

export type Jump = 'hidden' | 'down' | 'new';

/** The jump-to-latest button: hidden, ↓, or ↓ New. */
export function jumpOf(f: Follow): Jump {
  if (f.atEnd) return 'hidden';
  if (f.unseen) return 'new';
  return 'down';
}
