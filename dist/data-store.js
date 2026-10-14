// Where the learner's data (user-data.ts) lives, and the only module that
// loads or saves it.
//
//   file      polyglot-data.json in the ST user's files folder — the normal case
//   offline   the file could not be read yet: changes are kept in memory and
//             merged into the file once it loads (retried in the background)
//   chat      this ST cannot store files: the wordbook goes into each chat's
//             file and sets, wrong answers, the correction archive and the
//             study days into settings (the pre-1.5 layout)
//
// Reads are synchronous: the data is held in memory and the arrays handed out
// are live (mutate, then commit()). Saves are debounced, serialised, verified
// on the first write and retried with back-off; the user is warned while a
// save keeps failing and when they try to leave with unsaved changes. Unsaved
// changes are also kept in the browser (save-journal.ts) and taken in by the
// next load, so a tab closed before its save went through loses nothing.
//
// Older versions kept the data in settings.json (_wordbook, _sets,
// saved_wrong_answers). The first load moves it into the file and removes it
// from settings only after the file has been read back intact.
//
// Media files (words' sounds and pictures) a save no longer refers to, and
// files a closed page uploaded, are listed and deleted at a load a day later
// if still unused (media-files.ts).
//
// Several tabs or devices can save the same file, and ST writes it whole with
// no check of what it overwrites. Each save therefore records its id and the
// ids it grew from (user-data `revs`):
//   • a file grown from this session's last save: merged three-way, so what
//     another device deleted stays deleted
//   • a file that does not hold this session's last save (another device read
//     the file before that save landed and wrote over it): both copies are
//     merged with nothing deleted — which side deleted what cannot be told
//   • a little after each save the file is read back once; if it was written
//     over, the save is made again, merged with what is there now
import { KEY } from './constants.js';
import { getSettings, saveSettings } from './runtime.js';
import { chatMetadata, saveChatMetadata } from './storage.js';
import { notify } from './ui.manager.js';
import { t } from './i18n.js';
import { readUserFile, writeUserFile } from './user-files.js';
import { mediaIn, releaseMedia, sweepPending } from './media-files.js';
import { journal, journalNow, clearJournal, readJournals, dropJournals } from './save-journal.js';
import { emptyData, hasData, mergeUserData, parseData, rebaseUserData, serializeData, } from './user-data.js';
const DATA_FILE = 'polyglot-data.json';
/** One-time copy of the settings data, written before the first migration. */
const MIGRATION_COPY = 'polyglot-data-before-migration.json';
const SAVE_DELAY_MS = 800;
/** A burst of small changes (a run making sounds) is saved at most this often, not after each one. */
const BURST_SAVE_MS = 8000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Save ids a file keeps (its own first). */
const REVS_KEPT = 64;
/** A save is read back this long after it was written (one upload by another device can land in between). */
const CONFIRM_DELAY_MS = 15_000;
let mode = 'loading';
let data = emptyData();
/** Changes not yet written to the file (or, while loading/offline, not yet merged into it). */
let dirty = false;
let saving = null;
let saveTimer;
/** Every change waiting to be saved came in a burst (see commit). */
let burstOnly = false;
let retryTimer;
let failures = 0;
/** The file text as last read or written: the base the next save's changes are measured from. */
let lastText = '';
/** lastText's save history, its own id first (null: a file from before histories were kept). */
let lastRevs = null;
/** lastText (or a save grown from it) was read back from the server after it was written. */
let lastConfirmed = true;
/** A write whose request failed: the server may have stored it all the same (a reply lost on the way). */
let attempted = null;
let confirmTimer;
/** Media files the saved data refers to (unused ones are listed for deletion after a save). */
let savedMedia = new Set();
/** The unreadable file text last copied aside, so retries do not copy it again. */
let keptUnreadable = '';
const listeners = new Set();
const LEGACY_KEYS = ['_wordbook', '_sets', 'saved_wrong_answers', 'saved_checks', 'saved_days'];
/** A data array kept in settings, created on first use. */
function settingsList(key) {
    const s = getSettings();
    if (!Array.isArray(s[key]))
        s[key] = [];
    return s[key];
}
function legacySettingsData() {
    const s = getSettings();
    const arr = (k) => (Array.isArray(s[k]) ? s[k] : []);
    return {
        wordbook: arr('_wordbook'), sets: arr('_sets'), wrongAnswers: arr('saved_wrong_answers'),
        checks: arr('saved_checks'), days: arr('saved_days'),
    };
}
function dropLegacySettings() {
    const s = getSettings();
    LEGACY_KEYS.forEach(k => delete s[k]);
    saveSettings();
}
// ── Reading ──────────────────────────────────────────────────────────────────
export const storeMode = () => mode;
/** The open chat's wordbook in chat mode (settings when no chat is open). */
function chatWordbook() {
    const meta = chatMetadata();
    if (!meta)
        return settingsList('_wordbook');
    if (!Array.isArray(meta[KEY.wordbook]))
        meta[KEY.wordbook] = [];
    return meta[KEY.wordbook];
}
/** Every word (live array). In chat mode: the open chat's words only. */
export function wordbookData() {
    return mode === 'chat' ? chatWordbook() : data.wordbook;
}
export function setsData() {
    return mode === 'chat' ? settingsList('_sets') : data.sets;
}
export function wrongAnswersData() {
    return mode === 'chat' ? settingsList('saved_wrong_answers') : data.wrongAnswers;
}
export function checksData() {
    return mode === 'chat' ? settingsList('saved_checks') : data.checks;
}
export function daysData() {
    return mode === 'chat' ? settingsList('saved_days') : data.days;
}
/** A snapshot of all data (for backups). */
export function userData() {
    return { wordbook: wordbookData(), sets: setsData(), wrongAnswers: wrongAnswersData(), checks: checksData(), days: daysData() };
}
/** Called after the data was replaced from outside the session (load, reload, restore). */
export function onDataReplaced(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
const emitReplaced = () => listeners.forEach(l => l());
// ── Writing ──────────────────────────────────────────────────────────────────
/** A new save id (random; crypto.randomUUID needs https, which a LAN ST may not have). */
function newRev() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
/** Replaces any part of the data and saves it (`burst`: one of many changes in a row, see commit). */
export function replaceUserData(patch, burst = false) {
    if (mode === 'chat') {
        const meta = chatMetadata();
        if (patch.wordbook) {
            if (meta)
                meta[KEY.wordbook] = patch.wordbook;
            else
                getSettings()._wordbook = patch.wordbook;
        }
        if (patch.sets)
            getSettings()._sets = patch.sets;
        if (patch.wrongAnswers)
            getSettings().saved_wrong_answers = patch.wrongAnswers;
        if (patch.checks)
            getSettings().saved_checks = patch.checks;
        if (patch.days)
            getSettings().saved_days = patch.days;
    }
    else {
        data = { ...data, ...patch };
    }
    commit(burst);
}
/**
 * Schedules a save after the live arrays were changed. A `burst` change keeps
 * a save already scheduled, or schedules one a few seconds away: a run of
 * hundreds of changes writes the file every few seconds, not hundreds of times,
 * and its changes are committed (a reload cannot drop them) all along.
 */
export function commit(burst = false) {
    if (mode === 'chat') {
        if (chatMetadata())
            saveChatMetadata();
        saveSettings();
        return;
    }
    // Only burst changes waiting: the next save may wait a few seconds
    burstOnly = burst && (burstOnly || !dirty);
    dirty = true;
    journal(() => ({ data, baseText: lastText, at: Date.now() }));
    // While a save keeps failing, its back-off timer stays in charge
    if (mode !== 'file' || failures > 0)
        return;
    if (!burst)
        scheduleSave(SAVE_DELAY_MS);
    else if (saveTimer === undefined)
        scheduleSave(BURST_SAVE_MS);
}
function cancelSave() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
}
function scheduleSave(delay) {
    cancelSave();
    saveTimer = setTimeout(() => { saveTimer = undefined; void save(); }, delay);
}
/**
 * Takes in what another device saved since this session last read or wrote
 * the file, so a save never overwrites it. 'retry' when the file could not be
 * read (writing blind could undo the other device); 'newer' when a newer
 * Polyglot wrote it and it must never be written over.
 */
async function catchUp() {
    const res = await readUserFile(DATA_FILE);
    if (res.status === 'error')
        return 'retry';
    if (res.status === 'missing' || res.text === lastText)
        return 'ok';
    if (attempted && res.text === attempted.text) {
        // The write that looked failed reached the server, and nothing came after it
        setBase(attempted.text, attempted.revs, attempted.media);
        return 'ok';
    }
    const server = parseData(res.text);
    if (!server.ok) {
        if (server.reason === 'newer')
            return 'newer';
        // Unreadable: keep a copy before it is replaced, as on load
        return await keepUnreadable(res.text) ? 'ok' : 'retry';
    }
    const baseText = grownFrom(server.revs);
    if (baseText !== null) {
        const base = parseData(baseText);
        data = rebaseUserData(base.ok ? base.data : emptyData(), data, server.data);
    }
    else {
        // Written over a save of this session by a device that had not read it: which side
        // deleted what cannot be told, so both copies are kept (nothing is lost; a word
        // deleted meanwhile may come back)
        console.warn('[Polyglot] the data file was written over by another device; merging both copies');
        const { added: _a, merged: _m, ...merged } = mergeUserData(server.data, data);
        data = merged;
    }
    // What the file holds now is the next save's base, whether or not this save's write succeeds
    setBase(res.text, server.revs, mediaIn(server.data.wordbook));
    emitReplaced();
    return 'ok';
}
/**
 * The text this session's changes are measured from when the file holds
 * `revs`: its last save (or a write that looked failed) when the file grew
 * from it; null when the file does not hold it — written over by a device
 * that never read it.
 */
function grownFrom(revs) {
    if (attempted && revs?.includes(attempted.revs[0]))
        return attempted.text;
    // A file written by an older Polyglot has no history to check: as before
    if (!revs || !lastRevs)
        return lastText;
    if (revs.includes(lastRevs[0]))
        return lastText;
    // A save confirmed on the server, followed by more saves than a file keeps ids of
    if (lastConfirmed && revs.length >= REVS_KEPT)
        return lastText;
    return null;
}
/** The file read or written now becomes the base of the next save. */
function setBase(text, revs, media) {
    lastText = text;
    lastRevs = revs;
    lastConfirmed = true;
    attempted = null;
    // Media the file refers to joins what this session saved: files only one of them used are released after the next save
    savedMedia = new Set([...savedMedia, ...media]);
}
/** A little after a save, reads the file back: a device that read it before the save landed may have written over it. */
function scheduleConfirm() {
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => { void confirmSave(); }, CONFIRM_DELAY_MS);
}
async function confirmSave() {
    if (mode !== 'file' || saving || dirty || lastConfirmed)
        return;
    const res = await readUserFile(DATA_FILE);
    if (res.status !== 'ok' || mode !== 'file' || saving || dirty)
        return;
    if (res.text === lastText) {
        lastConfirmed = true;
        return;
    }
    const parsed = parseData(res.text);
    if (!parsed.ok)
        return;
    if (grownFrom(parsed.revs) !== null) {
        lastConfirmed = true;
        return;
    }
    // Written over: save again, merged with what the file holds now
    dirty = true;
    void save();
}
/** Writes the file once; a save requested meanwhile runs right after. */
function save() {
    if (saving)
        return saving;
    cancelSave();
    // Until the file has loaded, `data` is only part of the learner's data
    if (mode !== 'file')
        return Promise.resolve();
    saving = (async () => {
        dirty = false;
        burstOnly = false;
        const caught = await catchUp();
        if (caught === 'newer') {
            dirty = true;
            notify(t('data.newerFile'), 'err', 10000);
            goOffline();
            return;
        }
        const revs = [newRev(), ...(lastRevs ?? [])].slice(0, REVS_KEPT);
        const text = serializeData(data, new Date(), revs);
        const media = mediaIn(data.wordbook);
        const result = caught === 'ok' ? await writeUserFile(DATA_FILE, text) : 'error';
        if (result === 'ok') {
            lastText = text;
            lastRevs = revs;
            lastConfirmed = false;
            attempted = null;
            releaseMedia(savedMedia, media, mediaIn(data.wordbook));
            savedMedia = media;
            if (!dirty)
                clearJournal();
            if (failures > 0)
                notify(t('data.saveRecovered'), 'ok', 3000);
            failures = 0;
            scheduleConfirm();
            return;
        }
        // The request failed, but the server may have stored the file: the next catch-up tells
        if (caught === 'ok' && result === 'error')
            attempted = { text, revs, media };
        dirty = true;
        if (result === 'unsupported') {
            switchToChatMode();
            return;
        }
        if (failures === 0)
            notify(t('data.saveFailed'), 'warn', 6000);
        scheduleSave(RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)]);
        failures++;
    })().finally(() => {
        saving = null;
        if (dirty && mode === 'file' && failures === 0)
            scheduleSave(burstOnly ? BURST_SAVE_MS : SAVE_DELAY_MS);
    });
    return saving;
}
/**
 * Writes pending changes now. Resolves true when everything is on the server
 * (or in chat files, in chat mode); false while offline or after a failed write.
 */
export async function flush() {
    if (mode === 'chat')
        return true;
    if (mode !== 'file')
        return false;
    while (saving)
        await saving;
    if (dirty)
        await save();
    return !dirty;
}
// ── Loading and migration ────────────────────────────────────────────────────
/** Copies an unreadable data file aside before it is replaced — once, however often loading or saving is retried. */
async function keepUnreadable(text) {
    if (text === keptUnreadable)
        return true;
    const ok = await writeUserFile(`polyglot-data-unreadable-${Date.now()}.json`, text) === 'ok';
    if (ok)
        keptUnreadable = text;
    return ok;
}
/** Writes `text` and reads it back. */
async function writeVerified(name, text) {
    const written = await writeUserFile(name, text);
    if (written !== 'ok')
        return written;
    const back = await readUserFile(name);
    // Written but not readable at /user/files: this ST serves no user files
    if (back.status === 'missing')
        return 'unsupported';
    return back.status === 'ok' && back.text === text ? 'ok' : 'error';
}
function switchToChatMode() {
    if (mode === 'chat')
        return;
    // What this session holds goes to settings — the chat-mode place for words
    // saved outside a chat — so nothing is lost and no chat receives other chats' words
    const pending = data;
    mode = 'chat';
    cancelSave();
    clearTimeout(retryTimer);
    clearJournal();
    dirty = false;
    const merged = mergeUserData(legacySettingsData(), pending);
    Object.assign(getSettings(), {
        _wordbook: merged.wordbook, _sets: merged.sets, saved_wrong_answers: merged.wrongAnswers,
        saved_checks: merged.checks, saved_days: merged.days,
    });
    saveSettings();
    notify(t('data.chatMode'), 'warn', 8000);
    emitReplaced();
}
function goOffline() {
    if (mode !== 'offline')
        notify(t('data.loadFailed'), 'warn', 8000);
    mode = 'offline';
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { void load(); }, RETRY_DELAYS_MS.at(-1));
}
let loading = null;
/** Loads the data file, migrating settings data into it. Safe to call again (retries). */
export function initDataStore() {
    loading ??= load().finally(() => { loading = null; });
    return loading;
}
async function load() {
    if (mode === 'chat')
        return;
    if (mode === 'loading' && !hasData(data))
        data = structuredClone(legacySettingsData());
    const res = await readUserFile(DATA_FILE);
    if (res.status === 'error') {
        goOffline();
        return;
    }
    let server = null;
    let serverRevs = null;
    if (res.status === 'ok') {
        const parsed = parseData(res.text);
        if (parsed.ok) {
            server = parsed.data;
            serverRevs = parsed.revs;
        }
        else if (parsed.reason === 'newer') {
            // Written by a newer Polyglot: never overwrite it with less
            notify(t('data.newerFile'), 'err', 10000);
            goOffline();
            return;
        }
        else if (!await keepUnreadable(res.text)) {
            // Unreadable, and its copy could not be kept: it must not be replaced yet
            goOffline();
            return;
        }
    }
    const legacy = legacySettingsData();
    const migrating = hasData(legacy);
    const firstWrite = !server;
    if (migrating)
        await writeUserFile(MIGRATION_COPY, serializeData(legacy));
    // Changes a closed tab never saved, words added in this session before the file loaded,
    // and settings data join the file's
    let next = server ?? emptyData();
    const journals = await readJournals();
    for (const [, entry] of journals)
        next = takeInJournal(next, serverRevs, entry);
    if (journals.length)
        console.info(`[Polyglot] took in unsaved changes kept by ${journals.length} tab(s)`);
    if (dirty || migrating) {
        const { added: _a, merged: _m, ...merged } = mergeUserData(next, data);
        next = merged;
    }
    data = next;
    if (dirty || migrating || firstWrite || journals.length) {
        dirty = false; // changes made while writing set it again
        const revs = [newRev(), ...(serverRevs ?? [])].slice(0, REVS_KEPT);
        const text = serializeData(data, new Date(), revs);
        const result = await writeVerified(DATA_FILE, text);
        if (result === 'unsupported') {
            switchToChatMode();
            return;
        }
        if (result === 'error') {
            dirty = true;
            goOffline();
            return;
        }
        lastText = text;
        lastRevs = revs;
        dropJournals(journals);
        if (!dirty)
            clearJournal();
        if (migrating) {
            dropLegacySettings();
            notify(t('data.migrated', { n: legacy.wordbook.length }), 'ok', 5000);
        }
    }
    else {
        lastText = res.status === 'ok' ? res.text : '';
        lastRevs = serverRevs;
    }
    lastConfirmed = true;
    attempted = null;
    savedMedia = mediaIn(data.wordbook);
    sweepPending(savedMedia);
    const wasOffline = mode === 'offline';
    mode = 'file';
    failures = 0;
    clearTimeout(retryTimer);
    if (wasOffline)
        notify(t('data.saveRecovered'), 'ok', 3000);
    if (dirty)
        scheduleSave(SAVE_DELAY_MS);
    emitReplaced();
}
/**
 * A journal entry's data joined with the file's: three-way when the file grew
 * from the text the entry was based on (what that tab deleted stays deleted),
 * otherwise with nothing deleted. An entry that is not valid data is skipped.
 */
function takeInJournal(server, serverRevs, entry) {
    let local;
    try {
        const parsed = parseData(serializeData(entry.data));
        if (!parsed.ok)
            return server;
        local = parsed.data;
    }
    catch {
        return server;
    }
    const base = entry.baseText ? parseData(entry.baseText) : null;
    const baseRev = base?.ok ? base.revs?.[0] : undefined;
    if (base?.ok && baseRev && serverRevs?.includes(baseRev))
        return rebaseUserData(base.data, local, server);
    const { added: _a, merged: _m, ...merged } = mergeUserData(server, local);
    return merged;
}
/** Picks up changes saved from another device (on returning to the tab). */
async function reloadIfChanged() {
    if (mode !== 'file' || dirty || saving)
        return;
    const res = await readUserFile(DATA_FILE);
    if (res.status !== 'ok' || res.text === lastText || dirty || saving)
        return;
    const parsed = parseData(res.text);
    if (!parsed.ok)
        return;
    if (grownFrom(parsed.revs) === null) {
        // Written over a save of this session: save again, merged with it, rather than adopt it
        dirty = true;
        void save();
        return;
    }
    data = parsed.data;
    lastText = res.text;
    lastRevs = parsed.revs;
    lastConfirmed = true;
    savedMedia = mediaIn(data.wordbook);
    emitReplaced();
}
// ── Page lifecycle ───────────────────────────────────────────────────────────
const hasUnsaved = () => mode !== 'chat' && (dirty || saving !== null);
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', e => {
        if (!hasUnsaved())
            return;
        journalNow();
        void save();
        e.preventDefault();
    });
    // A hidden tab may be closed or killed without another event (mobile)
    window.addEventListener('pagehide', journalNow);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible')
            void reloadIfChanged();
        else {
            journalNow();
            if (dirty)
                void save();
        }
    });
}
