// Changes not yet saved to the data file, kept in the browser (IndexedDB) so a
// tab closed or killed before its save went through loses nothing. No DOM, no
// ST imports; data-store.ts decides what goes in and when.
//
//   journal(make)        keeps this tab's unsaved data shortly (make() is called then)
//   journalNow()         writes what is waiting now (the page is being hidden)
//   clearJournal()       this tab's data is saved: its entry goes
//   readJournals()       every tab's entry, for a load to take in
//   dropJournals(list)   entries a load wrote into the file (unless changed since)
//
// Each tab writes its own entry (a random key per page load), holding the
// whole data and the file text it was based on, so the load that takes it in
// can tell what was deleted (a three-way merge) when the file grew from that
// text. Without IndexedDB (blocked, private mode) every call does nothing.
import { KEY } from './constants.js';
/** How long changes wait before they are written (a run of changes writes once). */
const JOURNAL_DELAY_MS = 500;
const tabKey = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let store = indexedDbStore();
let waiting = null;
let timer;
/** Swaps the storage (tests). */
export function setJournalStore(s) {
    store = s;
}
export function journal(make) {
    waiting = make;
    timer ??= setTimeout(journalNow, JOURNAL_DELAY_MS);
}
export function journalNow() {
    clearTimeout(timer);
    timer = undefined;
    const make = waiting;
    waiting = null;
    if (make)
        void store.put(tabKey, make()).catch(() => { });
}
export function clearJournal() {
    clearTimeout(timer);
    timer = undefined;
    waiting = null;
    void store.remove(tabKey).catch(() => { });
}
/** Every tab's entry (this tab's own too, if any); [] without IndexedDB. */
export async function readJournals() {
    try {
        return await store.all();
    }
    catch {
        return [];
    }
}
export function dropJournals(entries) {
    for (const [key, entry] of entries)
        void store.remove(key, entry.at).catch(() => { });
}
// ── IndexedDB ────────────────────────────────────────────────────────────────
function indexedDbStore() {
    let db = null;
    const open = () => db ??= new Promise((resolve, reject) => {
        const req = indexedDB.open(KEY.journalDB, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(KEY.journalStore); };
        req.onsuccess = () => {
            const handle = req.result;
            handle.onversionchange = () => { handle.close(); db = null; };
            resolve(handle);
        };
        req.onerror = () => { db = null; reject(req.error); };
    });
    /** Runs `work` in one transaction; resolves with its result once the transaction is done. */
    const run = async (mode, work) => {
        const tx = (await open()).transaction(KEY.journalStore, mode);
        const result = work(tx.objectStore(KEY.journalStore));
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(result());
            tx.onerror = tx.onabort = () => reject(tx.error);
        });
    };
    return {
        put: (key, entry) => run('readwrite', s => { s.put(entry, key); return () => undefined; }),
        all: () => run('readonly', s => {
            const keys = s.getAllKeys(), values = s.getAll();
            return () => keys.result.map((k, i) => [String(k), values.result[i]]);
        }),
        remove: (key, at) => run('readwrite', s => {
            if (at === undefined)
                s.delete(key);
            else {
                const req = s.get(key);
                req.onsuccess = () => { if (req.result?.at === at)
                    s.delete(key); };
            }
            return () => undefined;
        }),
    };
}
