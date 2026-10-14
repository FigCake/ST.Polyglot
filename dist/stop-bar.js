// The "Analysing… Stop" bar at the bottom of the screen while message
// analyses run (annotator.ts). Several can run at once: the bar stays until
// the last one ends, and Stop stops them all.
import { html, setHtml } from './html.js';
import { t } from './i18n.js';
import { DELAY } from './constants.js';
/** Analyses running now, each with what stops it: the snackbar shows while any is, and Stop stops them all. */
const running = new Map();
export function showStopBar(run, onStop) {
    running.set(run, onStop);
    if (document.getElementById('pg-snackbar'))
        return;
    const el = Object.assign(document.createElement('div'), { id: 'pg-snackbar', className: 'pg-snackbar' });
    setHtml(el, html `
        <span class="pg-snackbar-text"><i class="fa-solid fa-spinner fa-spin"></i>&nbsp; ${t('ann.analysing')}</span>
        <button class="pg-snackbar-stop">${t('ann.stop')}</button>`);
    el.querySelector('.pg-snackbar-stop')?.addEventListener('click', () => {
        const stops = [...running.values()];
        running.clear();
        stops.forEach(stop => stop());
        removeSnackbar();
    });
    document.body.appendChild(el);
    void el.offsetWidth; // reflow so the entry transition runs on mobile
    el.classList.add('pg-snackbar-visible');
}
/** One analysis finished; the snackbar goes when none is left. */
export function hideStopBar(run) {
    running.delete(run);
    if (!running.size)
        removeSnackbar();
}
function removeSnackbar() {
    const el = document.getElementById('pg-snackbar');
    if (!el)
        return;
    el.id = ''; // fading out: a new analysis shows a snackbar of its own
    el.classList.remove('pg-snackbar-visible');
    setTimeout(() => el.remove(), DELAY.snackbarFadeOut);
}
