// Words' sound and picture files (e.g. from Anki) in the user's files folder,
// named by their content: pg-media-<16 hex>.<ext>.
//
//   mediaIn(words)        the files a wordbook refers to
//   noteUploaded(names)   files this session just stored (Anki import, restore)
//   releaseMedia(a, b)    deletes the files `a` used — or this session stored —
//                         that `b` does not use (nor the data in memory now);
//                         called by data-store.ts once `b` is safely saved
//   notePending(names)    files about to be uploaded, listed in the browser
//   sweepPending(inUse)   on load: deletes listed files a closed page left behind
//
// Uploaded files are noted right before the words that use them are added
// (no save can run in between), so a word deleted before its first save, or
// an import cancelled half-way, leaves no file behind. A page closed during
// an import never gets that far: what it uploaded stays listed in the browser
// until a save keeps or deletes it, and a later load deletes what no word uses.
//
// Only names of that exact shape are ever deleted.
import { deleteUserFile, userFileUrl } from './user-files.js';
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { getRequestHeaders } from '../../../../../script.js';
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
    }
    return names;
}
/** Whether a file is already in the user's files. */
async function mediaExists(name) {
    try {
        return (await fetch(userFileUrl(name), { method: 'HEAD', cache: 'no-store' })).ok;
    }
    catch {
        return false;
    }
}
/** Names checked per /api/files/verify request. */
const VERIFY_BATCH = 500;
/**
 * Which of the files are already in the user's files: one request per 500
 * names (ST's /api/files/verify), or one HEAD per file on an ST without it.
 */
export async function existingMedia(names) {
    // Asked about again (a restore, a re-import): files queued for deletion stay, and a
    // deletion already under way finishes first, so the answer is what will be there
    for (const n of names)
        doomed.delete(n);
    await deletingNow;
    const found = new Set();
    for (let i = 0; i < names.length; i += VERIFY_BATCH) {
        const batch = names.slice(i, i + VERIFY_BATCH);
        const urls = batch.map(n => `user/files/${n}`);
        let verified = null;
        try {
            const res = await fetch('/api/files/verify', {
                method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ urls }),
            });
            if (res.ok)
                verified = await res.json();
        }
        catch { /* fall back below */ }
        if (verified)
            batch.forEach((n, k) => { if (verified[urls[k]] === true)
                found.add(n); });
        else
            await inParallel(batch, 6, async (n) => { if (await mediaExists(n))
                found.add(n); });
    }
    return found;
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
// ── Uploads a closed page left behind ─────────────────────────────────────────
/**
 * How old a listed upload must be before a load deletes it: younger ones may
 * belong to an import still running in another tab, or to one whose save
 * has not gone through yet.
 */
const PENDING_STALE_MS = 24 * 3600_000;
/** Listed uploads: file name → when it was listed. */
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
    const pending = readPending();
    for (const n of names)
        if (isMediaName(n))
            pending[n] = now;
    writePending(pending);
}
function clearPending(names) {
    if (!names.length)
        return;
    const pending = readPending();
    names.forEach(n => delete pending[n]);
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
 * Deletes the files that `before` used (or this session stored) and the saved
 * `after` does not — best effort, in the background. `inUse` is what the data
 * refers to right now, which can be more than was saved: words added while the
 * save was being written keep their files (they are saved next).
 */
export function releaseMedia(before, after, inUse = after) {
    const gone = [...new Set([...before, ...uploaded])].filter(n => !after.has(n) && !inUse.has(n) && isMediaName(n));
    // Stored files not saved yet stay noted, so a later save can still let them go
    clearPending([...uploaded].filter(n => after.has(n)));
    for (const n of [...uploaded])
        if (after.has(n) || !inUse.has(n))
            uploaded.delete(n);
    deleteInBackground(gone);
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
