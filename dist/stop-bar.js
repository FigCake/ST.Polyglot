// The "Analysing… Stop" bar at the bottom of the screen while message
// requests run (annotator.ts, para-translate.ts). Several can run at once:
// the bar names the work when it is all of one kind, stays until the last one
// ends, and Stop stops them all.
import { html, setHtml } from './html.js';
import { t } from './i18n.js';
import { DELAY } from './constants.js';
/** Requests running now, each with what stops it and what it is: the snackbar shows while any is, and Stop stops them all. */
const running = new Map();
/** What the bar says: the work, when everything running is of one kind. */
function barLabel() {
    const labels = new Set([...running.values()].map(r => r.label));
    return labels.size === 1 ? [...labels][0] : t('stop.busy');
}
export function showStopBar(run, onStop, label = t('ann.analysing')) {
    running.set(run, { stop: onStop, label });
    const existing = document.getElementById('pg-snackbar');
    if (existing) {
        setLabel(existing);
        return;
    }
    const el = Object.assign(document.createElement('div'), { id: 'pg-snackbar', className: 'pg-snackbar' });
    setHtml(el, html `
        <span class="pg-snackbar-text"><i class="fa-solid fa-spinner fa-spin"></i>&nbsp; <span class="pg-snackbar-label">${barLabel()}</span></span>
        <button class="pg-snackbar-stop">${t('ann.stop')}</button>`);
    el.querySelector('.pg-snackbar-stop')?.addEventListener('click', () => {
        const stops = [...running.values()].map(r => r.stop);
        running.clear();
        stops.forEach(stop => stop());
        removeSnackbar();
    });
    document.body.appendChild(el);
    void el.offsetWidth; // reflow so the entry transition runs on mobile
    el.classList.add('pg-snackbar-visible');
}
/** One request finished; the snackbar goes when none is left. */
export function hideStopBar(run) {
    running.delete(run);
    const el = document.getElementById('pg-snackbar');
    if (!running.size)
        removeSnackbar();
    else if (el)
        setLabel(el);
}
function setLabel(bar) {
    const label = bar.querySelector('.pg-snackbar-label');
    if (label)
        label.textContent = barLabel();
}
function removeSnackbar() {
    const el = document.getElementById('pg-snackbar');
    if (!el)
        return;
    el.id = ''; // fading out: a new analysis shows a snackbar of its own
    el.classList.remove('pg-snackbar-visible');
    setTimeout(() => el.remove(), DELAY.snackbarFadeOut);
}
