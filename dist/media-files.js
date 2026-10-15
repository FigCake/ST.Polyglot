// Words' sound and picture files (e.g. from Anki) in the user's files folder,
// named by their content: pg-media-<16 hex>.<ext>.
//
//   mediaIn(words)        the files a wordbook refers to
//   noteUploaded(names)   files this session just stored (Anki import, restore, made sounds)
//   releaseMedia(a, b)    lists for deletion the files `a` used — or this session
//                         stored — that `b` does not use (nor the data in memory
//                         now); called by data-store.ts once `b` is safely saved
//   notePending(names)    files about to be uploaded, listed in the browser
//   sweepPending(inUse)   on load: deletes listed files a day old that no word uses
//
// Nothing is deleted when a save stops using a file. Files are named by their
// content, so another tab or device may have just found the same file present
// and put it on a word it has not saved yet (an Anki import, a made sound, a
// restore). The file is listed instead, and a load at least a day later
// deletes it if the data saved by then still does not use it.
//
// Uploaded files are noted right before the words that use them are added
// (no save can run in between), so a word deleted before its first save, or
// an import cancelled half-way, leaves no file behind. A page closed during
// an import never gets that far: what it uploaded is listed in the browser
// before the upload, so the same later load deletes what no word uses.
//
// Only names of that exact shape are ever deleted.
import { deleteUserFile, userFilesExist } from './user-files.js';
import { KEY } from './constants.js';
const MEDIA_NAME = /^pg-media-[0-9a-f]{16}\.[a-z0-9]{2,5}$/;
export const isMediaName = (name) => typeof name === 'string' && MEDIA_NAME.test(name);
/**
 * File types kept as a word's sound or picture. ST serves user files from its
 * own origin, so only types a browser shows passively are stored: no SVG,
 * HTML or XML, which would run scripts if someone opened the file's URL.
 */
const AUDIO = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'webm']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp']);
const extOf = (name) => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';
/** A 64-bit content fingerprint (two FNV-1a passes), as hex. */
export function bytesHash(bytes) {
    let a = 0x811c9dc5, b = 0x01000193 ^ bytes.length;
    for (let i = 0; i < bytes.length; i++) {
        a = Math.imul(a ^ bytes[i], 0x01000193);
        b = Math.imul(b ^ bytes[i], 0x5bd1e995) ^ (b >>> 15);
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
/** The user-files name for a media file's bytes (`original` gives the extension). */
export const mediaFileName = (bytes, original) => `pg-media-${bytesHash(bytes)}.${extOf(original)}`;
/** Whether a file of this name can be kept as a word's sound or picture. */
export const keepableMedia = (name, kind) => (kind === 'sound' ? AUDIO : IMAGE).has(extOf(name));
/** The media files the words refer to. */
export function mediaIn(words) {
    const names = new Set();
    for (const w of words) {
        if (isMediaName(w.audio))
            names.add(w.audio);
        if (isMediaName(w.image))
            names.add(w.image);
        if (isMediaName(w.example_audio))
            names.add(w.example_audio);
    }
    return names;
}
/**
 * Whether a file is known to be gone from the user's files: only a clear
 * answer counts (the server says it is not there). A server that does not
 * answer (restarting, a network blip) says nothing, so nothing is replaced.
 */
export async function mediaGone(name) {
    return (await userFilesExist([name])).get(name) === false;
}
/** Which of the files are already in the user's files. */
export async function existingMedia(names) {
    // Asked about again (a restore, a re-import, a sound made again): files queued for
    // deletion stay, and a deletion already under way finishes first, so the answer is
    // what will be there. They are no longer this session's spare uploads either: until
    // a word takes them (and they are noted again), no save may let them go.
    for (const n of names) {
        doomed.delete(n);
        uploaded.delete(n);
    }
    await deletingNow;
    const answers = await userFilesExist(names);
    return new Set(names.filter(n => answers.get(n) === true));
}
/** Runs `task` over the items, at most `limit` at a time. */
export async function inParallel(items, limit, task) {
    let next = 0;
    const worker = async () => { while (next < items.length)
        await task(items[next++]); };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
/** Files stored in this session that no save has accounted for yet. */
const uploaded = new Set();
/** Files waiting in the background deletion queue, and the one being deleted now. */
const doomed = new Set();
let deletingNow = null;
export function noteUploaded(names) {
    for (const n of names)
        if (isMediaName(n))
            uploaded.add(n);
}
// ── Files listed for deletion: unused ones, and uploads a closed page left behind ──
/**
 * How old a listed file must be before a load deletes it: younger ones may
 * belong to an import still running in another tab, to one whose save has
 * not gone through yet, or to a word another device has not saved yet.
 */
const PENDING_STALE_MS = 24 * 3600_000;
/** Listed files: file name → when it was listed. */
function readPending() {
    try {
        const v = JSON.parse(localStorage.getItem(KEY.mediaPending) ?? '{}');
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    }
    catch {
        return {};
    }
}
function writePending(pending) {
    try {
        if (Object.keys(pending).length)
            localStorage.setItem(KEY.mediaPending, JSON.stringify(pending));
        else
            localStorage.removeItem(KEY.mediaPending);
    }
    catch { /* storage blocked: nothing is listed, as before */ }
}
/** Lists files about to be uploaded (before the upload: one that reached the server unanswered is listed too). */
export function notePending(names, now = Date.now()) {
    const listed = [...names].filter(isMediaName);
    if (!listed.length)
        return;
    const pending = readPending();
    for (const n of listed)
        pending[n] = now;
    writePending(pending);
}
function clearPending(names) {
    const pending = readPending();
    let changed = false;
    for (const n of names)
        if (Object.hasOwn(pending, n)) {
            delete pending[n];
            changed = true;
        }
    if (changed)
        writePending(pending);
}
/** Deletes the listed uploads older than a day that no word uses; called once the data has loaded. */
export function sweepPending(inUse, now = Date.now()) {
    const pending = readPending();
    const stale = Object.keys(pending).filter(n => !(now - pending[n] < PENDING_STALE_MS) && !uploaded.has(n));
    clearPending(stale.filter(n => inUse.has(n) || !isMediaName(n)));
    deleteInBackground(stale.filter(n => !inUse.has(n) && isMediaName(n)));
}
/**
 * Lists for deletion the files that `before` used (or this session stored) and
 * the saved `after` does not; a load a day later deletes them if still unused
 * (see the top). Listed files the saved words use again are unlisted. `inUse`
 * is what the data refers to right now, which can be more than was saved:
 * words added while the save was being written keep their files (they are
 * saved next).
 */
export function releaseMedia(before, after, inUse = after, now = Date.now()) {
    const gone = [...new Set([...before, ...uploaded])].filter(n => !after.has(n) && !inUse.has(n) && isMediaName(n));
    clearPending(after);
    // Stored files not saved yet stay noted, so a later save can still list them
    for (const n of [...uploaded])
        if (after.has(n) || !inUse.has(n))
            uploaded.delete(n);
    notePending(gone, now);
}
/** Deletes the files one at a time, in the background; a file is unlisted once it is gone. */
function deleteInBackground(gone) {
    if (!gone.length)
        return;
    gone.forEach(n => doomed.add(n));
    void (async () => {
        for (const name of gone) {
            if (!doomed.delete(name))
                continue; // wanted again meanwhile (existingMedia)
            deletingNow = deleteUserFile(name);
            if (await deletingNow)
                clearPending([name]);
            else
                console.warn('[Polyglot] could not delete unused media file', name);
            deletingNow = null;
        }
    })();
}
