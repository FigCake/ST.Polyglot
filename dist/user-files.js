// Reads and writes files in the ST user's files folder (data/<user>/user/files),
// the same place ST's Data Bank keeps attachments.
//
//   write   POST /api/files/upload  { name, data: base64 }  — atomic on the server
//   read    GET  /user/files/<name>                          — static, so no-store; with the
//           version tag (ETag) of a copy the caller holds, ST answers 304 and sends nothing
//   version HEAD /user/files/<name>                          — the ETag and size, no content
//   delete  POST /api/files/delete  { path: 'user/files/<name>' }
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
