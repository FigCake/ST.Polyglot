// Where the learner's data (user-data.ts) lives, and the only module that
// loads or saves it.
//
//   file      polyglot-data.json in the ST user's files folder — the normal case
//   offline   the file could not be read yet: changes are kept in memory and
//             merged into the file once it loads (retried in the background)
//   chat      this ST cannot store files: the wordbook goes into each chat's
//             file and sets / wrong answers into settings (the pre-1.5 layout)
//
// Reads are synchronous: the data is held in memory and the arrays handed out
// are live (mutate, then commit()). Saves are debounced, serialised, verified
// on the first write and retried with back-off; the user is warned while a
// save keeps failing and when they try to leave with unsaved changes.
//
// Older versions kept the data in settings.json (_wordbook, _sets,
// saved_wrong_answers). The first load moves it into the file and removes it
// from settings only after the file has been read back intact.
//
// Unused media files (words' sounds and pictures) are deleted once a save
// no longer refers to them.
import { KEY } from './constants.js';
import { getSettings, saveSettings } from './runtime.js';
import { chatMetadata, saveChatMetadata } from './storage.js';
import { notify } from './ui.manager.js';
import { t } from './i18n.js';
import { readUserFile, writeUserFile } from './user-files.js';
import { mediaIn, releaseMedia } from './media-files.js';
import { emptyData, hasData, mergeUserData, parseData, rebaseUserData, serializeData, } from './user-data.js';
const DATA_FILE = 'polyglot-data.json';
/** One-time copy of the settings data, written before the first migration. */
const MIGRATION_COPY = 'polyglot-data-before-migration.json';
const SAVE_DELAY_MS = 800;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
let mode = 'loading';
let data = emptyData();
/** Changes not yet written to the file (or, while loading/offline, not yet merged into it). */
let dirty = false;
let saving = null;
let saveTimer;
let retryTimer;
let failures = 0;
/** The file text as last read or written, to skip no-op reloads. */
let lastText = '';
/** Media files the saved data refers to (unused ones are deleted after a save). */
let savedMedia = new Set();
const listeners = new Set();
const LEGACY_KEYS = ['_wordbook', '_sets', 'saved_wrong_answers'];
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
    return { wordbook: arr('_wordbook'), sets: arr('_sets'), wrongAnswers: arr('saved_wrong_answers') };
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
/** A snapshot of all data (for backups). */
export function userData() {
    return { wordbook: wordbookData(), sets: setsData(), wrongAnswers: wrongAnswersData() };
}
/** Called after the data was replaced from outside the session (load, reload, restore). */
export function onDataReplaced(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
const emitReplaced = () => listeners.forEach(l => l());
// ── Writing ──────────────────────────────────────────────────────────────────
/** Replaces any part of the data and saves it. */
export function replaceUserData(patch) {
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
    }
    else {
        data = { ...data, ...patch };
    }
    commit();
}
/** Schedules a save after the live arrays were changed. */
export function commit() {
    if (mode === 'chat') {
        if (chatMetadata())
            saveChatMetadata();
        saveSettings();
        return;
    }
    dirty = true;
    // While a save keeps failing, its back-off timer stays in charge
    if (mode === 'file' && failures === 0)
        scheduleSave(SAVE_DELAY_MS);
}
function scheduleSave(delay) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void save(); }, delay);
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
    const server = parseData(res.text);
    if (!server.ok) {
        if (server.reason === 'newer')
            return 'newer';
        // Unreadable: keep a copy before it is replaced, as on load
        return await writeUserFile(`polyglot-data-unreadable-${Date.now()}.json`, res.text) === 'ok' ? 'ok' : 'retry';
    }
    const base = parseData(lastText);
    data = rebaseUserData(base.ok ? base.data : emptyData(), data, server.data);
    emitReplaced();
    return 'ok';
}
/** Writes the file once; a save requested meanwhile runs right after. */
function save() {
    if (saving)
        return saving;
    clearTimeout(saveTimer);
    // Until the file has loaded, `data` is only part of the learner's data
    if (mode !== 'file')
        return Promise.resolve();
    saving = (async () => {
        dirty = false;
        const caught = await catchUp();
        if (caught === 'newer') {
            dirty = true;
            notify(t('data.newerFile'), 'err', 10000);
            goOffline();
            return;
        }
        const text = serializeData(data);
        const media = mediaIn(data.wordbook);
        const result = caught === 'ok' ? await writeUserFile(DATA_FILE, text) : 'error';
        if (result === 'ok') {
            lastText = text;
            releaseMedia(savedMedia, media, mediaIn(data.wordbook));
            savedMedia = media;
            if (failures > 0)
                notify(t('data.saveRecovered'), 'ok', 3000);
            failures = 0;
            return;
        }
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
            scheduleSave(SAVE_DELAY_MS);
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
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    dirty = false;
    const merged = mergeUserData(legacySettingsData(), pending);
    Object.assign(getSettings(), { _wordbook: merged.wordbook, _sets: merged.sets, saved_wrong_answers: merged.wrongAnswers });
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
    if (res.status === 'ok') {
        const parsed = parseData(res.text);
        if (parsed.ok)
            server = parsed.data;
        else if (parsed.reason === 'newer') {
            // Written by a newer Polyglot: never overwrite it with less
            notify(t('data.newerFile'), 'err', 10000);
            goOffline();
            return;
        }
        else {
            // Unreadable: keep a copy before it is replaced
            await writeUserFile(`polyglot-data-unreadable-${Date.now()}.json`, res.text);
        }
    }
    const legacy = legacySettingsData();
    const migrating = hasData(legacy);
    const firstWrite = !server;
    if (migrating)
        await writeUserFile(MIGRATION_COPY, serializeData(legacy));
    // Words added in this session before the file loaded, and settings data, join the file's
    let next = server ?? emptyData();
    if (dirty || migrating) {
        const { added: _a, merged: _m, ...merged } = mergeUserData(next, data);
        next = merged;
    }
    data = next;
    if (dirty || migrating || firstWrite) {
        dirty = false; // changes made while writing set it again
        const text = serializeData(data);
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
        if (migrating) {
            dropLegacySettings();
            notify(t('data.migrated', { n: legacy.wordbook.length }), 'ok', 5000);
        }
    }
    else {
        lastText = res.status === 'ok' ? res.text : '';
    }
    savedMedia = mediaIn(data.wordbook);
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
    data = parsed.data;
    lastText = res.text;
    savedMedia = mediaIn(data.wordbook);
    emitReplaced();
}
// ── Page lifecycle ───────────────────────────────────────────────────────────
const hasUnsaved = () => mode !== 'chat' && (dirty || saving !== null);
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', e => {
        if (!hasUnsaved())
            return;
        void save();
        e.preventDefault();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible')
            void reloadIfChanged();
        else if (dirty)
            void save();
    });
}
