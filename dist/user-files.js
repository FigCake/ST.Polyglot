// Reads and writes files in the ST user's files folder (data/<user>/user/files),
// the same place ST's Data Bank keeps attachments.
//
//   write   POST /api/files/upload  { name, data: base64 }  — atomic on the server
//   read    GET  /user/files/<name>                          — static, so no-store; with the
//           version tag (ETag) of a copy the caller holds, ST answers 304 and sends nothing
//   version HEAD /user/files/<name>                          — the ETag and size, no content
//   delete  POST /api/files/delete  { path: 'user/files/<name>' }
//   exists  POST /api/files/verify  { urls }                 — many at once; HEAD each on an ST without it
//
// This module is the only one that knows where files live: the web app and the
// Marinara extension build swap it for one keeping files in the browser (hosts/common).
//
// Every call reports an outcome instead of throwing, so callers can tell a
// missing file or an old ST without the API from a passing network error.
import { getRequestHeaders } from './st.js';
import { withTimeout } from './utils.js';
import { recordProblem, errorText } from './diagnostics.js';
const TIMEOUT_MS = 30_000;
/** Slowest upload speed allowed for before giving up (≈ 50 KB/s). */
const UPLOAD_BYTES_PER_MS = 50;
/** File names the upload endpoint accepts: letters, digits, `_`, `-`, `.`. */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
export const userFileUrl = (name) => `/user/files/${encodeURIComponent(name)}`;
/** Whether the files are kept in this browser instead of on the server (never, in ST). */
export const filesInBrowser = () => false;
function assertName(name) {
    if (!SAFE_NAME.test(name))
        throw new Error(`Invalid user file name: ${name}`);
}
/**
 * Bytes (or UTF-8 text) → base64. The browser's own encoder when it has one;
 * otherwise 8K chunks through fromCharCode.apply (spreading a large array into
 * fromCharCode overflows the stack, and spreading 32K chunks is ~7× slower).
 */
export function toBase64(data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const native = bytes.toBase64;
    if (typeof native === 'function')
        return native.call(bytes);
    const parts = [];
    for (let i = 0; i < bytes.length; i += 0x2000) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000)));
    }
    return btoa(parts.join(''));
}
/**
 * Reads a file. With `etag` (the version tag of a copy the caller holds) a file
 * the server still has in that version is not sent again: 'unchanged'.
 */
export async function readUserFile(name, etag) {
    assertName(name);
    try {
        const res = await fetch(`${userFileUrl(name)}?t=${Date.now()}`, {
            cache: 'no-store',
            // A no-store request otherwise goes out with "Cache-Control: no-cache", and ST then always sends the whole file
            headers: etag ? { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } : undefined,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 304)
            return { status: 'unchanged' };
        if (res.status === 404)
            return { status: 'missing' };
        if (!res.ok) {
            recordProblem('file', `read ${name}: HTTP ${res.status}`);
            return { status: 'error' };
        }
        return { status: 'ok', text: await res.text(), etag: res.headers.get('ETag') ?? undefined };
    }
    catch (e) {
        recordProblem('file', `read ${name}: ${errorText(e)}`);
        return { status: 'error' };
    }
}
/** A file's version tag (ETag) and size in bytes, without its content; null when unknown. */
export async function userFileVersion(name) {
    assertName(name);
    try {
        const res = await fetch(`${userFileUrl(name)}?t=${Date.now()}`, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
        const etag = res.headers.get('ETag'), size = Number(res.headers.get('Content-Length'));
        return res.ok && etag && Number.isFinite(size) ? { etag, size } : null;
    }
    catch {
        return null;
    }
}
/** A file's bytes, or null when it is missing or unreadable. */
export async function readUserBytes(name) {
    assertName(name);
    try {
        const res = await fetch(userFileUrl(name), { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok)
            recordProblem('file', `read ${name}: HTTP ${res.status}`);
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    }
    catch (e) {
        recordProblem('file', `read ${name}: ${errorText(e)}`);
        return null;
    }
}
/** Creates or replaces a file (text is stored as UTF-8). 'unsupported' = this ST has no upload endpoint. */
export async function writeUserFile(name, data, signal) {
    assertName(name);
    try {
        // Base64 needs no escaping: the body is put together directly (JSON.stringify of a
        // multi-MB string costs a noticeable moment on every save of a large wordbook)
        const body = `{"name":${JSON.stringify(name)},"data":"${toBase64(data)}"}`;
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body,
            // Large files (media) get time in proportion to their size
            signal: withTimeout(signal, Math.max(TIMEOUT_MS, body.length / UPLOAD_BYTES_PER_MS)),
        });
        if (res.ok)
            return 'ok';
        recordProblem('file', `write ${name}: HTTP ${res.status}`);
        return res.status === 404 || res.status === 405 ? 'unsupported' : 'error';
    }
    catch (e) {
        if (!signal?.aborted)
            recordProblem('file', `write ${name}: ${errorText(e)}`);
        return 'error';
    }
}
/** A file check that gets no answer for this long counts as no answer. */
const CHECK_TIMEOUT_MS = 30_000;
/** Names checked per /api/files/verify request. */
const VERIFY_BATCH = 500;
/** Whether a file answers a HEAD request: true / false (404) / undefined (no clear answer). */
async function headAnswer(name) {
    try {
        const res = await fetch(userFileUrl(name), { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        return res.ok ? true : res.status === 404 ? false : undefined;
    }
    catch {
        return undefined;
    }
}
/** ST's verify endpoint for these names; null when this ST has none or does not answer. */
async function verifyAnswer(names) {
    try {
        const res = await fetch('/api/files/verify', {
            method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ urls: names.map(n => `user/files/${n}`) }),
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        return res.ok ? await res.json() : null;
    }
    catch {
        return null;
    }
}
/**
 * Whether each file is in the user's files: true / false, or undefined when
 * there was no clear answer (a server restarting, a network blip). One verify
 * request per 500 names; one HEAD per file (6 at a time) on an ST without it.
 */
export async function userFilesExist(names) {
    const found = new Map();
    for (let i = 0; i < names.length; i += VERIFY_BATCH) {
        const batch = names.slice(i, i + VERIFY_BATCH);
        const verified = await verifyAnswer(batch);
        if (verified) {
            batch.forEach(n => { const v = verified[`user/files/${n}`]; found.set(n, typeof v === 'boolean' ? v : undefined); });
            continue;
        }
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(6, batch.length) }, async () => {
            while (next < batch.length) {
                const n = batch[next++];
                found.set(n, await headAnswer(n));
            }
        }));
    }
    return found;
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
        if (!res.ok && res.status !== 404)
            recordProblem('file', `delete ${name}: HTTP ${res.status}`);
        return res.ok || res.status === 404;
    }
    catch (e) {
        recordProblem('file', `delete ${name}: ${errorText(e)}`);
        return false;
    }
}
