// Runs AI re-analysis of wordbook entries with a progress bar and a Stop button.
// Used by the wordbook toolbar (selected words) and the settings tab (all words).
import { html, setHtml } from '../html.js';
import { t } from '../i18n.js';
import { askConfirm, notify } from '../ui.manager.js';
import { scopedWordbook } from '../wordbook.js';
import { ai, getLang, getNativeLang } from '../runtime.js';
import { runReanalysis, abortReanalysis, isReanalysisRunning } from '../features/reanalysis.js';
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
    bar.hidden = false;
    setHtml(bar, html `
        <div class="pg-reanalysis-progress">
            <span class="pg-reanalysis-text" aria-live="polite">${t('wb.reanalyseProgress', { done: 0, total })}</span>
            <button class="pg-reanalysis-stop">${t('ann.stop')}</button>
        </div>
        <div class="pg-reanalysis-track"><div class="pg-reanalysis-fill"></div></div>`);
    bar.querySelector('.pg-reanalysis-stop')?.addEventListener('click', () => abortReanalysis());
    const text = bar.querySelector('.pg-reanalysis-text');
    const fill = bar.querySelector('.pg-reanalysis-fill');
    onBusy?.(true);
    await runReanalysis({ ai, getLang, getNativeLang }, {
        words: targets,
        onProgress(done, all, word) {
            if (text)
                text.textContent = t('wb.reanalyseProgress', { done, total: all, word });
            if (fill)
                fill.style.width = `${all ? Math.round((done / all) * 100) : 0}%`;
        },
        onDone(processed, all, aborted, error) {
            bar.hidden = true;
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
