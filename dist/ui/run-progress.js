// The progress strip of a long run over many words (AI re-analysis, making
// sounds): a line of text, a Stop button and a bar, shown in a placeholder
// element (class pg-run-bar, hidden while idle).
//
// The placeholder may be given as a lookup: a tab that redraws during the run
// gets a fresh placeholder, and the strip moves into it at the next update.
import { html, setHtml } from '../html.js';
import { t } from '../i18n.js';
/** Strips of runs under way, redrawn when their tab is drawn again (redrawRunProgress). */
const active = new Set();
/** Draws the strips of runs under way into their (new) placeholders right away. */
export function redrawRunProgress() {
    active.forEach(draw => draw());
}
/** Shows the strip in the target; Stop calls `onStop`. */
export function openRunProgress(target, text, onStop) {
    const placeholder = () => (typeof target === 'function' ? target() : target);
    let state = { text, ratio: 0 };
    /** The strip in the current placeholder, drawn there if it is not yet. */
    function strip() {
        const bar = placeholder();
        if (!bar)
            return null;
        if (!bar.querySelector('.pg-run-progress')) {
            setHtml(bar, html `
                <div class="pg-run-progress">
                    <span class="pg-run-text" aria-live="polite"></span>
                    <button class="pg-run-stop">${t('ann.stop')}</button>
                </div>
                <div class="pg-run-track"><div class="pg-run-fill"></div></div>`);
            bar.querySelector('.pg-run-stop')?.addEventListener('click', onStop);
        }
        bar.hidden = false;
        return bar;
    }
    function draw() {
        const bar = strip();
        const line = bar?.querySelector('.pg-run-text');
        const fill = bar?.querySelector('.pg-run-fill');
        if (line)
            line.textContent = state.text;
        if (fill)
            fill.style.width = `${Math.round(state.ratio * 100)}%`;
    }
    draw();
    active.add(draw);
    return {
        update(next, done, total) {
            state = { text: next, ratio: total ? done / total : 0 };
            draw();
        },
        close() {
            active.delete(draw);
            const bar = placeholder();
            if (bar) {
                bar.hidden = true;
                setHtml(bar, html ``);
            }
        },
    };
}
