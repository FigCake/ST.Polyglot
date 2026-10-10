// ════════════════════════════
// Polyglot  features/match.ts
// ════════════════════════════
// Word ↔ meaning matching game: pick a word and a meaning; a correct pair locks,
// a wrong pair flashes and resets. Up to MAX_PAIRS random vocabulary entries.
//
// Dependencies: utils.ts, html.ts, i18n.ts, wordbook.ts, constants.ts
import { CEFR_LEVELS } from '../constants.js';
import { shuffleArray } from '../utils.js';
import { html, setHtml } from '../html.js';
import { t } from '../i18n.js';
import { scopedWordbook, getSets } from '../wordbook.js';
const MAX_PAIRS = 12;
const MIN_PAIRS = 4;
/** How long a wrong pair stays red, and the pause before the completion message. */
const FEEDBACK_MS = 600;
function matchableWords(setId, level) {
    return scopedWordbook().filter(w => w.level !== 'grammar' && w.level !== 'sentence' &&
        (setId === 'all' || (w.setIds ?? []).includes(setId)) &&
        (level === 'all' || w.level === level));
}
// ── Game ──────────────────────────────────────────────────────────────────────
function startGame(gameEl, words) {
    const pairs = shuffleArray(words).slice(0, MAX_PAIRS);
    let matched = 0;
    const picked = {};
    const card = (w, side) => html `
        <button class="pg-match-card pg-match-${side}" data-side="${side}" data-word="${w.word}">${side === 'word' ? w.word : w.meaning}</button>`;
    setHtml(gameEl, html `
        <div class="pg-match-header">
            <span class="pg-match-score" aria-live="polite">0 / ${pairs.length}</span>
            <button class="pg-icon-btn pg-match-quit" title="${t('mat.quit')}" aria-label="${t('mat.quit')}"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="pg-match-grid">
            <div class="pg-match-col">${shuffleArray(pairs).map(w => card(w, 'word'))}</div>
            <div class="pg-match-col">${shuffleArray(pairs).map(w => card(w, 'mean'))}</div>
        </div>`);
    const settle = () => {
        const { word, mean } = picked;
        if (!word || !mean)
            return;
        picked.word = picked.mean = undefined;
        if (word.dataset.word !== mean.dataset.word) {
            word.classList.add('pg-match-wrong');
            mean.classList.add('pg-match-wrong');
            setTimeout(() => [word, mean].forEach(c => c.classList.remove('pg-match-wrong', 'pg-match-selected')), FEEDBACK_MS);
            return;
        }
        word.classList.add('pg-match-correct');
        mean.classList.add('pg-match-correct');
        const score = gameEl.querySelector('.pg-match-score');
        if (score)
            score.textContent = `${++matched} / ${pairs.length}`;
        if (matched === pairs.length) {
            setTimeout(() => setHtml(gameEl, html `<div class="pg-match-complete">${t('mat.done', { n: pairs.length })}</div>`), FEEDBACK_MS);
        }
    };
    gameEl.onclick = e => {
        const target = e.target;
        if (target.closest('.pg-match-quit')) {
            gameEl.replaceChildren();
            return;
        }
        const el = target.closest('.pg-match-card');
        if (!el || el.matches('.pg-match-correct, .pg-match-wrong'))
            return;
        const side = el.dataset.side;
        picked[side]?.classList.remove('pg-match-selected');
        picked[side] = el;
        el.classList.add('pg-match-selected');
        settle();
    };
}
// ── Setup ─────────────────────────────────────────────────────────────────────
/** Renders the set/level pickers, the available-word count and the Start button. */
export function renderMatchSetup(container) {
    setHtml(container, html `
        <div class="pg-match-setup">
            <div class="pg-match-setup-title">${t('mat.title')}</div>
            <div class="pg-match-options">
                <select class="pg-set-select pg-match-set" aria-label="${t('mat.allWords')}">
                    <option value="all">${t('mat.allWords')}</option>
                    ${getSets().map(s => html `<option value="${s.id}">${s.name}</option>`)}
                </select>
                <select class="pg-set-select pg-match-level" aria-label="${t('mat.allLevels')}">
                    <option value="all">${t('mat.allLevels')}</option>
                    ${CEFR_LEVELS.map(l => html `<option value="${l}">${l}</option>`)}
                </select>
            </div>
            <div class="pg-match-count"></div>
            <button class="pg-btn pg-btn-primary pg-btn-full pg-match-start">${t('mat.start')}</button>
        </div>
        <div class="pg-match-game"></div>`);
    const value = (cls) => container.querySelector(cls)?.value ?? 'all';
    const words = () => matchableWords(value('.pg-match-set'), value('.pg-match-level'));
    const count = container.querySelector('.pg-match-count');
    const start = container.querySelector('.pg-match-start');
    const update = () => {
        const n = words().length;
        if (count)
            count.textContent = n >= MIN_PAIRS
                ? t('mat.available', { total: n, n: Math.min(n, MAX_PAIRS) })
                : t('mat.notEnough', { n });
        if (start)
            start.disabled = n < MIN_PAIRS;
    };
    container.querySelector('.pg-match-options')?.addEventListener('change', update);
    start?.addEventListener('click', () => startGame(container.querySelector('.pg-match-game'), words()));
    update();
}
