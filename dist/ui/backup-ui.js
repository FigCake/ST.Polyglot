// ════════════════════════════
// Polyglot  ui/backup-ui.ts
// ════════════════════════════
// Buttons for backup.ts: save a backup, and restore one (merge or replace)
// from a .json file or a .zip with media.
//
// Dependencies: backup.ts, data-store.ts, i18n.ts, ui.manager.ts
import { downloadBackup, parseBackup, restoreBackup, openBackupZip, withoutMedia, } from '../backup.js';
import { storeMode } from '../data-store.js';
import { askChoice, notify } from '../ui.manager.js';
import { t, currentLang } from '../i18n.js';
export async function saveBackup() {
    const { words, media } = await downloadBackup();
    notify(media ? t('pnl.set.backupDoneMedia', { n: words, m: media }) : t('pnl.set.backupDone', { n: words }), 'ok', 3000);
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
    const mode = await askChoice(t('pnl.set.restoreAsk', { date: formatDate(backup.exportedAt), n: backup.wordbook.length }), [
        { value: 'cancel', label: t('confirmNo') },
        { value: 'replace', label: t('pnl.set.restoreReplace') },
        { value: 'merge', label: t('pnl.set.restoreMerge'), primary: true },
    ]);
    if (!mode || mode === 'cancel')
        return false;
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
