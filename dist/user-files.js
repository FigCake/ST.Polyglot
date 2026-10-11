// Reads and writes files in the ST user's files folder (data/<user>/user/files),
// the same place ST's Data Bank keeps attachments.
//
//   write   POST /api/files/upload  { name, data: base64 }  — atomic on the server
//   read    GET  /user/files/<name>                          — static, so no-store
//   delete  POST /api/files/delete  { path: 'user/files/<name>' }
//
// Every call reports an outcome instead of throwing, so callers can tell a
// missing file or an old ST without the API from a passing network error.
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { getRequestHeaders } from '../../../../../script.js';
const TIMEOUT_MS = 30_000;
/** Slowest upload speed allowed for before giving up (≈ 50 KB/s). */
const UPLOAD_BYTES_PER_MS = 50;
/** `signal` (if any) combined with a timeout — without AbortSignal.any, which older Safari lacks. */
function withTimeout(signal, ms) {
    const timeout = AbortSignal.timeout(ms);
    if (!signal)
        return timeout;
    const both = new AbortController();
    const abort = () => both.abort();
    for (const s of [signal, timeout]) {
        if (s.aborted)
            both.abort();
        else
            s.addEventListener('abort', abort, { once: true });
    }
    return both.signal;
}
/** File names the upload endpoint accepts: letters, digits, `_`, `-`, `.`. */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
export const userFileUrl = (name) => `/user/files/${encodeURIComponent(name)}`;
function assertName(name) {
    if (!SAFE_NAME.test(name))
        throw new Error(`Invalid user file name: ${name}`);
}
/** Bytes (or UTF-8 text) → base64, in chunks (spreading a large array into fromCharCode overflows the stack). */
function toBase64(data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}
export async function readUserFile(name) {
    assertName(name);
    try {
        const res = await fetch(`${userFileUrl(name)}?t=${Date.now()}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 404)
            return { status: 'missing' };
        if (!res.ok)
            return { status: 'error' };
        return { status: 'ok', text: await res.text() };
    }
    catch {
        return { status: 'error' };
    }
}
/** A file's bytes, or null when it is missing or unreadable. */
export async function readUserBytes(name) {
    assertName(name);
    try {
        const res = await fetch(userFileUrl(name), { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    }
    catch {
        return null;
    }
}
/** Creates or replaces a file (text is stored as UTF-8). 'unsupported' = this ST has no upload endpoint. */
export async function writeUserFile(name, data, signal) {
    assertName(name);
    try {
        const body = JSON.stringify({ name, data: toBase64(data) });
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body,
            // Large files (media) get time in proportion to their size
            signal: withTimeout(signal, Math.max(TIMEOUT_MS, body.length / UPLOAD_BYTES_PER_MS)),
        });
        if (res.ok)
            return 'ok';
        return res.status === 404 || res.status === 405 ? 'unsupported' : 'error';
    }
    catch {
        return 'error';
    }
}
/** Deletes a file; true when it is gone (a file that was already missing too). */
export async function deleteUserFile(name) {
    assertName(name);
    try {
        const res = await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: `user/files/${name}` }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return res.ok || res.status === 404;
    }
    catch {
        return false;
    }
}
