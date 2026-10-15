// Full backup / restore as one JSON file:
//
//   wordbook (with review schedules, notes, chat tags) · word sets · saved
//   wrong answers · correction archive · study days · settings · cached
//   conjugation tables
//
// When words have sounds or pictures (media-files.ts), the backup is a zip:
//
//   polyglot-backup.json   the JSON above
//   media/pg-media-….mp3   each file the words use
//
// A restore puts the files back before the words that use them.
//
// API keys and the AI connection (provider, model, Custom base URL) are never
// written to a backup or restored from one: a backup from someone else could
// otherwise point this device's key at their server.
//
// Restore modes:
//   merge    add new words, combine duplicates (user-data.mergeUserData),
//            add missing sets / wrong answers / tables; settings stay as they are
//   replace  the backup's data and settings replace the current ones
//
// createBackup / parseBackup are pure and unit-tested (merging: user-data.ts).
import { downloadText, downloadBlob } from './export/download.js';
import { buildZip, readZip, readEntry } from './zip.js';
import { mediaIn, existingMedia, inParallel, isMediaName, keepableMedia, noteUploaded, notePending } from './media-files.js';
import { readUserBytes, writeUserFile } from './user-files.js';
import { getSettings, saveSettings, prepareSettings, DEFAULT_SETTINGS } from './runtime.js';
import { listConjCache, setConjCache, clearConjCacheStore } from './conj-cache.js';
import { userData, replaceUserData, storeMode } from './data-store.js';
import { cleanData, mergeUserData, list, num } from './user-data.js';
import { isRecord } from './ai/client.js';
export const BACKUP_FORMAT = 'polyglot-backup';
const BACKUP_VERSION = 1;
/**
 * Settings keys that hold data (backed up separately), or say where requests
 * go with the keys left on the device: a restored file must not send a key to
 * an address it chose. Every API key (a name ending in "_key") is left out too.
 */
const NOT_SETTINGS = new Set([
    '_wordbook', '_sets', 'saved_wrong_answers', 'saved_checks', 'saved_days',
    'ext_api_key', 'ext_base_url', 'provider', 'model', '_model_history', 'route_chat_source', 'route_model', 'profile_id', 'host_connection',
    'voice_provider', 'voice_oa_url', 'voice_proxy',
]);
const isApiKey = (k) => k.endsWith('_key');
/**
 * Only known setting keys are restored. This also keeps keys such as
 * "__proto__" in a crafted file from reaching Object.assign.
 */
const RESTORABLE = new Set(Object.keys(DEFAULT_SETTINGS).filter(k => !NOT_SETTINGS.has(k) && !isApiKey(k)));
// ── Pure ──────────────────────────────────────────────────────────────────────
export function createBackup(settings, data, conjugations, now = new Date()) {
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: now.toISOString(),
        // Known settings only: a key left by an old version (say, an API key) never leaks into a backup
        settings: Object.fromEntries(Object.entries(settings).filter(([k]) => RESTORABLE.has(k))),
        wordbook: data.wordbook,
        sets: data.sets,
        wrongAnswers: data.wrongAnswers,
        checks: data.checks,
        days: data.days,
        conjugations,
    };
}
const isConj = (v) => isRecord(v) && typeof v.word === 'string' && typeof v.lang === 'string' && isRecord(v.data) && Array.isArray(v.data.tenses);
/** Reads and validates a backup file; unusable items are dropped, not fatal. */
export function parseBackup(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return { ok: false, reason: 'invalid' };
    }
    if (!isRecord(raw) || raw.format !== BACKUP_FORMAT)
        return { ok: false, reason: 'invalid' };
    if (num(raw.version, 0) > BACKUP_VERSION)
        return { ok: false, reason: 'newer' };
    const settings = isRecord(raw.settings)
        ? Object.fromEntries(Object.entries(raw.settings).filter(([k]) => RESTORABLE.has(k)))
        : {};
    return {
        ok: true,
        backup: {
            format: BACKUP_FORMAT,
            version: num(raw.version, BACKUP_VERSION),
            exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
            settings: settings,
            ...cleanData(raw),
            conjugations: list(raw.conjugations, isConj),
        },
    };
}
// ── Effects ───────────────────────────────────────────────────────────────────
export const BACKUP_JSON = 'polyglot-backup.json';
const MEDIA_DIR = 'media/';
/**
 * Saves a backup file (a zip when words have media); returns how many words and media files it holds, and how many files
 * on the server could not be read into it. `onMedia` hears how many sounds and pictures have been read (thousands take a while).
 */
export async function downloadBackup(onMedia) {
    const backup = createBackup(getSettings(), userData(), await listConjCache());
    const name = `Polyglot_Backup_${backup.exportedAt.slice(0, 10)}`;
    const json = JSON.stringify(backup, null, 1);
    const media = storeMode() === 'file' ? [...mediaIn(backup.wordbook)] : [];
    if (!media.length) {
        downloadText(json, `${name}.json`, 'application/json');
        return { words: backup.wordbook.length, media: 0, missing: 0 };
    }
    const files = [{ name: BACKUP_JSON, data: new TextEncoder().encode(json) }];
    const unread = [];
    // Six reads at a time (one by one took minutes for thousands of files); the zip keeps the list's order
    const read = [];
    let done = 0;
    onMedia?.(0, media.length);
    await inParallel(media.map((_, i) => i), 6, async (i) => {
        read[i] = await readUserBytes(media[i]);
        onMedia?.(++done, media.length);
    });
    media.forEach((file, i) => {
        const data = read[i];
        if (data)
            files.push({ name: MEDIA_DIR + file, data });
        else
            unread.push(file);
    });
    downloadBlob(buildZip(files), `${name}.zip`);
    // A file already gone from the server is no loss; one that is there but could not be read is
    const missing = (await existingMedia(unread)).size;
    return { words: backup.wordbook.length, media: files.length - 1, missing };
}
/** Opens a backup zip; null when the zip is not a Polyglot backup. */
export async function openBackupZip(file) {
    const entries = await readZip(file);
    const json = entries.get(BACKUP_JSON);
    if (!json)
        return null;
    return {
        text: new TextDecoder().decode(await readEntry(file, json)),
        restoreMedia: async (words) => {
            let failed = 0;
            const written = [];
            // Only the sound / picture types Polyglot keeps: a crafted backup could hold an
            // .svg or .xhtml that would run scripts on ST's origin if its URL were opened
            const keepable = (name) => keepableMedia(name, 'sound') || keepableMedia(name, 'image');
            const packed = [...mediaIn(words)].filter(name => isMediaName(name) && entries.has(MEDIA_DIR + name));
            const inZip = packed.filter(keepable);
            failed += packed.length - inZip.length;
            const present = await existingMedia(inZip);
            const missing = inZip.flatMap(name => {
                const entry = entries.get(MEDIA_DIR + name);
                return entry && !present.has(name) ? [{ name, entry }] : [];
            });
            notePending(missing.map(m => m.name));
            await inParallel(missing, 6, async ({ name, entry }) => {
                const ok = await readEntry(file, entry)
                    .then(bytes => writeUserFile(name, bytes))
                    .then(r => r === 'ok', () => false);
                if (ok)
                    written.push(name);
                else
                    failed++;
            });
            noteUploaded(written);
            return failed;
        },
    };
}
/** Settings that make the browser contact an address of the backup's choosing (a background image, a dictionary). */
const ADDRESS_KEYS = ['panel_bg_image', 'dict_url_custom'];
/** The addresses a replace would set that differ from the current ones (a backup from someone else may bring them). */
export function newAddresses(backup, current) {
    return ADDRESS_KEYS.flatMap(k => {
        const v = backup.settings[k];
        return typeof v === 'string' && v.trim() && v !== current[k] ? [v] : [];
    });
}
/** The backup without its address settings: the current ones stay. */
export function withoutAddresses(backup) {
    const settings = { ...backup.settings };
    for (const k of ADDRESS_KEYS)
        delete settings[k];
    return { ...backup, settings };
}
/** Without file storage there is nowhere to keep media: words lose their links to it. */
export function withoutMedia(backup) {
    return { ...backup, wordbook: backup.wordbook.map(({ audio: _a, example_audio: _e, image: _i, made_sounds: _m, ...w }) => w) };
}
async function restoreConjugations(entries, replace) {
    if (replace)
        await clearConjCacheStore();
    const existing = replace ? new Set() : new Set((await listConjCache()).map(c => c.word));
    await Promise.all(entries.filter(c => !existing.has(c.word)).map(c => setConjCache(c.word, c.data, c.lang)));
}
/** Applies a parsed backup. Returns { added, merged } for merges, { added: total } for replaces. */
export async function restoreBackup(backup, mode) {
    if (mode === 'replace') {
        const s = getSettings();
        Object.assign(s, backup.settings, { ext_api_key: s.ext_api_key });
        prepareSettings(s); // an old backup's values (say, a furigana size no longer offered)
        saveSettings();
        replaceUserData({
            wordbook: backup.wordbook, sets: backup.sets, wrongAnswers: backup.wrongAnswers, checks: backup.checks, days: backup.days,
        });
        await restoreConjugations(backup.conjugations, true);
        return { added: backup.wordbook.length, merged: 0 };
    }
    const { added, merged, ...data } = mergeUserData(userData(), backup);
    replaceUserData(data);
    await restoreConjugations(backup.conjugations, false);
    return { added, merged };
}
