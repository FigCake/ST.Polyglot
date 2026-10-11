// IndexedDB storage for conjugation tables. No DOM, no AI calls, no ST imports.
// It knows nothing of settings or the wordbook: callers pass `lang`, and
// clearConjCacheStore() leaves the entries' `conj_cached` flags to the caller
// (see clearAllConjCache() in wordbook.ts).
import { KEY } from './constants.js';
// ── DB handle ─────────────────────────────────────────────────────────────────
let dbPromise = null;
/** The conjugation IndexedDB, opened (and created) once and shared by every call. */
function _getConjDB() {
    dbPromise ??= new Promise((resolve, reject) => {
        const req = indexedDB.open(KEY.conjDB, KEY.conjDBVersion);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(KEY.conjStore);
        };
        req.onsuccess = () => {
            const db = req.result;
            // Another tab is upgrading the database: let it, and reopen on next use
            db.onversionchange = () => { db.close(); dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
}
// ── Public API ────────────────────────────────────────────────────────────────
/** Cached table for a word (base form), or null when missing or cached for another language. */
export async function getConjCache(word, currentLang) {
    try {
        const db = await _getConjDB();
        const entry = await new Promise((resolve, reject) => {
            const req = db.transaction(KEY.conjStore).objectStore(KEY.conjStore).get(word);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        if (!entry)
            return null;
        if (entry.lang !== currentLang)
            return null;
        return entry.data;
    }
    catch {
        return null; // IDB unavailable or blocked — caller falls back to API
    }
}
/** Saves a table under the word's base form, tagged with the learning language. */
export async function setConjCache(word, data, currentLang) {
    try {
        const db = await _getConjDB();
        const entry = { data, lang: currentLang, cachedAt: Date.now() };
        await new Promise((resolve, reject) => {
            const req = db
                .transaction(KEY.conjStore, 'readwrite')
                .objectStore(KEY.conjStore)
                .put(entry, word);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
    catch {
        // IDB write failed — table still displays correctly, just won't be cached
    }
}
/** Called when a wordbook entry is deleted or its base form changes. */
export async function deleteConjCache(word) {
    try {
        const db = await _getConjDB();
        await new Promise((resolve, reject) => {
            const req = db
                .transaction(KEY.conjStore, 'readwrite')
                .objectStore(KEY.conjStore)
                .delete(word);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
    catch (e) {
        // Non-critical: a stale table may remain until the next language switch clears the store.
        console.warn('[Polyglot] conj-cache: deleteConjCache failed for word:', word, e);
    }
}
/** Wipes the store. Does NOT reset `conj_cached` flags (wordbook.ts `clearAllConjCache` does). */
export async function clearConjCacheStore() {
    try {
        const db = await _getConjDB();
        await new Promise((resolve, reject) => {
            const req = db
                .transaction(KEY.conjStore, 'readwrite')
                .objectStore(KEY.conjStore)
                .clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
    catch (e) {
        // Non-critical, but log it so it shows in devtools.
        console.warn('[Polyglot] conj-cache: clearConjCacheStore failed', e);
    }
}
/** Every well-formed cached table, in all languages (for backups). */
export async function listConjCache() {
    try {
        const db = await _getConjDB();
        return await new Promise((resolve, reject) => {
            const out = [];
            const req = db.transaction(KEY.conjStore, 'readonly').objectStore(KEY.conjStore).openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve(out);
                    return;
                }
                const entry = cursor.value;
                if (entry?.data?.tenses?.length)
                    out.push({ word: String(cursor.key), lang: entry.lang, data: entry.data });
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }
    catch {
        return [];
    }
}
/** Cached tables for the current study language (stale languages are skipped). Used by the PDF export and verb drill. */
export async function getAllConjEntries(currentLang) {
    return (await listConjCache())
        .filter(e => e.lang === currentLang)
        .map(({ word, data }) => ({ word, data }));
}
