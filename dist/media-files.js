// ════════════════════════════
// Polyglot  media-files.ts
// ════════════════════════════
// Words' sound and picture files (e.g. from Anki) in the user's files folder,
// named by their content: pg-media-<16 hex>.<ext>.
//
//   mediaIn(words)        the files a wordbook refers to
//   noteUploaded(names)   files this session just stored (Anki import, restore)
//   releaseMedia(a, b)    deletes the files `a` used — or this session stored —
//                         that `b` does not use; called by data-store.ts once
//                         `b` is safely saved
//
// Uploaded files are noted right before the words that use them are added
// (no save can run in between), so a word deleted before its first save, or
// an import cancelled half-way, leaves no file behind.
//
// Only names of that exact shape are ever deleted.
//
// Dependencies: user-files.ts
import { deleteUserFile, userFileUrl } from './user-files.js';
const MEDIA_NAME = /^pg-media-[0-9a-f]{16}\.[a-z0-9]{2,5}$/;
export const isMediaName = (name) => typeof name === 'string' && MEDIA_NAME.test(name);
/** The media files the words refer to. */
export function mediaIn(words) {
    const names = new Set();
    for (const w of words) {
        if (isMediaName(w.audio))
            names.add(w.audio);
        if (isMediaName(w.image))
            names.add(w.image);
    }
    return names;
}
/** Whether a file is already in the user's files. */
export async function mediaExists(name) {
    try {
        return (await fetch(userFileUrl(name), { method: 'HEAD', cache: 'no-store' })).ok;
    }
    catch {
        return false;
    }
}
/** Files stored in this session that no save has accounted for yet. */
const uploaded = new Set();
export function noteUploaded(names) {
    for (const n of names)
        if (isMediaName(n))
            uploaded.add(n);
}
/** Deletes the files that `before` used (or this session stored) and `after` does not — best effort, in the background. */
export function releaseMedia(before, after) {
    const gone = [...new Set([...before, ...uploaded])].filter(n => !after.has(n) && isMediaName(n));
    uploaded.clear();
    if (!gone.length)
        return;
    void (async () => {
        for (const name of gone) {
            if (!await deleteUserFile(name))
                console.warn('[Polyglot] could not delete unused media file', name);
        }
    })();
}
