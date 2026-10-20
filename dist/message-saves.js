// What every per-message save in chat metadata (annotations, translations,
// furigana) has in common: entries kept by message index, one per text the
// message has shown (each with its text hash `h`).
import { relocateEntries } from './utils.js';
import { shownTextHashes } from './plain-text.js';
import { getContext } from './runtime.js';
/** Messages were deleted and ST renumbered the rest: the saved entries follow their messages. */
export function relocateSaves(store) {
    const saved = store.get();
    const length = getContext().chat?.length;
    const moved = saved && typeof length === 'number' && relocateEntries(saved, shownTextHashes(), length);
    if (moved)
        store.set(moved);
}
