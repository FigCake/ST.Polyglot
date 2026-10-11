// Buttons for backup.ts: save a backup, and restore one (merge or replace)
// from a .json file or a .zip with media.
import { downloadBackup, parseBackup, restoreBackup, openBackupZip, withoutMedia, } from '../backup.js';
import { storeMode } from '../data-store.js';
import { askChoice, notify } from '../ui.manager.js';
import { t, currentLang } from '../i18n.js';
/**
 * Downloads a backup; false (after telling the user) when it could not be
 * made, or — with `complete` — when some media files could not be read into it.
 */
export async function saveBackup(complete = false) {
    try {
        const { words, media, missing } = await downloadBackup();
        notify(media ? t('pnl.set.backupDoneMedia', { n: words, m: media }) : t('pnl.set.backupDone', { n: words }), 'ok', 3000);
        if (missing)
            notify(t('pnl.set.backupMissing', { n: missing }), 'warn', 8000);
        return !(complete && missing);
    }
    catch (err) {
        console.error('[Polyglot] Backup failed:', err);
        notify(t('pnl.set.backupFailed', { err: err instanceof Error ? err.message : String(err) }), 'err', 6000);
        return false;
    }
}
const formatDate = (iso) => iso ? new Date(iso).toLocaleString(currentLang(), { dateStyle: 'medium', timeStyle: 'short' }) : '?';
/** Asks merge / replace for a backup file (.json, or .zip with media) and applies it. Returns true when data changed. */
export async function restoreFromFile(file) {
    if (!/\.zip$/i.test(file.name))
        return restore(await file.text());
    const archive = await openBackupZip(file).catch(() => null);
    if (!archive) {
        notify(t('pnl.set.restoreInvalid'), 'err', 4000);
        return false;
    }
    return restore(archive.text, archive);
}
async function restore(text, archive) {
    const parsed = parseBackup(text);
    if (!parsed.ok) {
        notify(t(parsed.reason === 'newer' ? 'pnl.set.restoreNewer' : 'pnl.set.restoreInvalid'), 'err', 4000);
        return false;
    }
    let { backup } = parsed;
    // Until the data file has loaded, a restore could only be merged in later, without its media
    if (storeMode() === 'loading' || storeMode() === 'offline') {
        notify(t('pnl.set.restoreNotLoaded'), 'warn', 6000);
        return false;
    }
    const mode = await askChoice(t('pnl.set.restoreAsk', { date: formatDate(backup.exportedAt), n: backup.wordbook.length }), [
        { value: 'cancel', label: t('confirmNo') },
        { value: 'replace', label: t('pnl.set.restoreReplace') },
        { value: 'merge', label: t('pnl.set.restoreMerge'), primary: true },
    ]);
    if (!mode || mode === 'cancel')
        return false;
    if (mode === 'replace') {
        // Nothing replaced can be brought back otherwise (its media files are deleted too),
        // so the safety backup must hold everything
        if (!await saveBackup(true)) {
            notify(t('pnl.set.restoreNoSafety'), 'err', 8000);
            return false;
        }
    }
    // Media first, so no word points at a file that is not there yet
    if (storeMode() !== 'file')
        backup = withoutMedia(backup);
    else if (archive) {
        const failed = await archive.restoreMedia(backup.wordbook);
        if (failed)
            notify(t('anki.mediaFailed', { n: failed }), 'warn', 6000);
    }
    const { added, merged } = await restoreBackup(backup, mode);
    notify(mode === 'merge'
        ? t('pnl.set.restoreMerged', { added, merged })
        : t('pnl.set.restoreReplaced', { n: added }), 'ok', 4000);
    return true;
}
