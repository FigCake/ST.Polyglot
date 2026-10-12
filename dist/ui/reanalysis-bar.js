// Runs AI re-analysis of wordbook entries with a progress bar and a Stop button.
// Used by the wordbook toolbar (selected words) and the settings tab (all words).
import { t } from '../i18n.js';
import { askConfirm, notify } from '../ui.manager.js';
import { scopedWordbook } from '../wordbook.js';
import { ai, getLang, getNativeLang } from '../runtime.js';
import { runReanalysis, abortReanalysis, isReanalysisRunning } from '../features/reanalysis.js';
import { openRunProgress } from './run-progress.js';
const pending = (words) => scopedWordbook().filter(e => words ? words.has(e.word) : e.level !== 'grammar' && e.level !== 'sentence');
/** Starts a run — or stops the current one when a run is already active. */
export async function toggleReanalysis({ bar, words, confirm, onBusy, onDone }) {
    if (isReanalysisRunning()) {
        abortReanalysis();
        return;
    }
    const targets = pending(words && new Set(words)).map(e => e.word);
    const total = targets.length;
    if (!total) {
        notify(t('wb.reanalyseNone'), 'warn');
        return;
    }
    if (confirm && !(await askConfirm(t('wb.reanalyseConfirm', { n: total }), { yes: t('wb.reanalyseStart'), no: t('confirmNo') })))
        return;
    const progress = openRunProgress(bar, t('wb.reanalyseProgress', { done: 0, total }), abortReanalysis);
    onBusy?.(true);
    await runReanalysis({ ai, getLang, getNativeLang }, {
        words: targets,
        onProgress(done, all, word) {
            progress.update(t('wb.reanalyseProgress', { done, total: all, word }), done, all);
        },
        onDone(processed, all, aborted, error) {
            progress.close();
            onBusy?.(false);
            if (error)
                notify(t('wb.reanalyseFailed', { done: processed, total: all, msg: error }), 'err', 6000);
            else
                notify(aborted
                    ? t('wb.reanalyseStopped', { done: processed, total: all })
                    : t('wb.reanalyseDone', { n: processed }), aborted ? 'warn' : 'ok', 3000);
            onDone?.();
        },
    });
}
