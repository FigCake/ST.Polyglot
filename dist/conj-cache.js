// ════════════════════════════
// Polyglot  conj-cache.ts
// ════════════════════════════
// IndexedDB persistence layer for conjugation tables.
//
// Design rules:
//   • Pure I/O — no DOM, no API calls, no ST imports.
//   • No dependency on getLang() or wordbook state.
//     Callers pass `lang` explicitly so this module stays side-effect-free.
//   • clearConjCacheStore() only wipes the IDB store.
//     Resetting wordbook `conj_cached` flags is the caller's responsibility
//     (see clearAllConjCache() in index.ts).
//
// Dependencies: constants.ts, types.ts only.
import { KEY } from './constants.js';
// ── DB handle ─────────────────────────────────────────────────────────────────
/** Opens (and lazily creates) the conjugation IndexedDB. */
function _getConjDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(KEY.conjDB, KEY.conjDBVersion);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(KEY.conjStore);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Reads a cached conjugation table.
 *
 * Returns `null` if:
 *   • the word has no cached entry, or
 *   • the cached entry's language differs from `currentLang`
 *     (user switched learning languages since the table was fetched).
 *
 * @param word        Canonical wordbook key (base form).
 * @param currentLang Current learning language from settings — used for
 *                    invalidation only; not stored here.
 */
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
        // Invalidate when the user has switched learning languages
        if (entry.lang !== currentLang)
            return null;
        return entry.data;
    }
    catch {
        return null; // IDB unavailable or blocked — caller falls back to API
    }
}
/**
 * Writes a conjugation table to IndexedDB.
 *
 * @param word        Canonical wordbook key.
 * @param data        Parsed conjugation response from the AI.
 * @param currentLang Current learning language — stored alongside data for
 *                    future invalidation checks.
 */
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
/**
 * Removes the cached table for a single word.
 * Called when a wordbook entry is deleted.
 */
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
        // IDB delete failed — stale cache may remain, but wordbook entry is still removed.
        // Non-critical: the cache will be invalidated on next language switch.
        console.warn('[Polyglot] conj-cache: deleteConjCache failed for word:', word, e);
    }
}
/**
 * Wipes every entry from the IDB store.
 *
 * NOTE: This does NOT reset `conj_cached` flags on wordbook entries.
 *       Callers (index.ts `clearAllConjCache`) are responsible for that step
 *       so this module stays free of wordbook state.
 */
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
        // IDB clear failed — cached conjugation tables may persist.
        // Non-critical, but log so the issue is visible in devtools.
        console.warn('[Polyglot] conj-cache: clearConjCacheStore failed', e);
    }
}
/**
 * Returns every cached conjugation entry from IDB as a flat array.
 * Entries whose lang differs from `currentLang` are excluded (stale cache).
 *
 * Used by exportToPDF to collect conjugation tables for the print section.
 */
export async function getAllConjEntries(currentLang) {
    try {
        const db = await _getConjDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(KEY.conjStore, 'readonly');
            const store = tx.objectStore(KEY.conjStore);
            const out = [];
            const allReq = store.getAll();
            const keyReq = store.getAllKeys();
            let allDone = false, keyDone = false;
            let allValues = [];
            let allKeys = [];
            const tryResolve = () => {
                if (!allDone || !keyDone)
                    return;
                allKeys.forEach((key, i) => {
                    const entry = allValues[i];
                    if (!entry)
                        return;
                    if (entry.lang !== currentLang)
                        return; // stale — skip
                    if (!entry.data?.tenses?.length)
                        return; // malformed — skip
                    out.push({ word: String(key), data: entry.data });
                });
                db.close();
                resolve(out);
            };
            allReq.onsuccess = () => { allValues = allReq.result; allDone = true; tryResolve(); };
            keyReq.onsuccess = () => { allKeys = keyReq.result; keyDone = true; tryResolve(); };
            allReq.onerror = () => { db.close(); reject(allReq.error); };
            keyReq.onerror = () => { db.close(); reject(keyReq.error); };
        });
    }
    catch {
        return [];
    }
}
