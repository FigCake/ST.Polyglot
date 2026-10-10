// ════════════════════════════
// Polyglot  backup.ts
// ════════════════════════════
// Full backup / restore as one JSON file:
//
//   wordbook (with SRS progress, notes, chat tags) · word sets · saved wrong
//   answers · settings · cached conjugation tables
//
// When words have sounds or pictures (media-files.ts), the backup is a zip:
//
//   polyglot-backup.json   the JSON above
//   media/pg-media-….mp3   each file the words use
//
// A restore puts the files back before the words that use them.
//
// API keys are never written to a backup, and a restore never overwrites the
// key currently configured.
//
// Restore modes:
//   merge    add new words, combine duplicates (user-data.mergeUserData),
//            add missing sets / wrong answers / tables; settings stay as they are
//   replace  the backup's data and settings replace the current ones
//
// createBackup / parseBackup are pure and unit-tested (merging: user-data.ts).
import { downloadText, downloadBlob } from './export/download.js';
import { buildZip, readZip, readEntry } from './zip.js';
import { mediaIn, mediaExists, isMediaName, noteUploaded } from './media-files.js';
import { readUserBytes, writeUserFile } from './user-files.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from './runtime.js';
import { listConjCache, setConjCache, clearConjCacheStore } from './conj-cache.js';
import { userData, replaceUserData, storeMode } from './data-store.js';
import { cleanData, mergeUserData, isRecord, list, num } from './user-data.js';
export const BACKUP_FORMAT = 'polyglot-backup';
export const BACKUP_VERSION = 1;
/** Settings keys that hold data (backed up separately) or secrets (never backed up). */
const NOT_SETTINGS = new Set(['_wordbook', '_sets', 'saved_wrong_answers', 'ext_api_key']);
/**
 * Only known setting keys are restored. This also keeps keys such as
 * "__proto__" in a crafted file from reaching Object.assign.
 */
const RESTORABLE = new Set(Object.keys(DEFAULT_SETTINGS).filter(k => !NOT_SETTINGS.has(k)));
// ── Pure ──────────────────────────────────────────────────────────────────────
export function createBackup(settings, data, conjugations, now = new Date()) {
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: now.toISOString(),
        settings: Object.fromEntries(Object.entries(settings).filter(([k]) => !NOT_SETTINGS.has(k))),
        wordbook: data.wordbook,
        sets: data.sets,
        wrongAnswers: data.wrongAnswers,
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
/** Saves a backup file (a zip when words have media); returns how many words and media files it holds. */
export async function downloadBackup() {
    const backup = createBackup(getSettings(), userData(), await listConjCache());
    const name = `Polyglot_Backup_${backup.exportedAt.slice(0, 10)}`;
    const json = JSON.stringify(backup, null, 1);
    const media = storeMode() === 'file' ? [...mediaIn(backup.wordbook)] : [];
    if (!media.length) {
        downloadText(json, `${name}.json`, 'application/json');
        return { words: backup.wordbook.length, media: 0 };
    }
    const files = [{ name: BACKUP_JSON, data: new TextEncoder().encode(json) }];
    for (const file of media) {
        const data = await readUserBytes(file);
        if (data)
            files.push({ name: MEDIA_DIR + file, data });
    }
    downloadBlob(buildZip(files), `${name}.zip`);
    return { words: backup.wordbook.length, media: files.length - 1 };
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
            for (const name of mediaIn(words)) {
                const entry = entries.get(MEDIA_DIR + name);
                if (!entry || !isMediaName(name) || await mediaExists(name))
                    continue;
                if (await writeUserFile(name, await readEntry(file, entry)) === 'ok')
                    written.push(name);
                else
                    failed++;
            }
            noteUploaded(written);
            return failed;
        },
    };
}
/** Without file storage there is nowhere to keep media: words lose their links to it. */
export function withoutMedia(backup) {
    return { ...backup, wordbook: backup.wordbook.map(({ audio: _a, image: _i, ...w }) => w) };
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
        saveSettings();
        replaceUserData({ wordbook: backup.wordbook, sets: backup.sets, wrongAnswers: backup.wrongAnswers });
        await restoreConjugations(backup.conjugations, true);
        return { added: backup.wordbook.length, merged: 0 };
    }
    const { added, merged, ...data } = mergeUserData(userData(), backup);
    replaceUserData(data);
    await restoreConjugations(backup.conjugations, false);
    return { added, merged };
}
