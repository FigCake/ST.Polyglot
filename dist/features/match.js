// ════════════════════════════
// Polyglot  features/match.ts
// ════════════════════════════
// Word–Meaning matching game.
//
// Design rules:
//   • No dependency on index.ts — wordbook access is direct.
//   • shuffleArray / escapeHtml injected via MatchDeps so the module
//     stays testable without a DOM.
//
// Dependencies: constants.ts, types.ts, utils.ts, ui.manager.ts, wordbook.ts
import { escapeHtml } from '../ui.manager.js';
import { shuffleArray } from '../utils.js';
import { loadWordbook, getSets } from '../wordbook.js';
import { t } from '../i18n.js';
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Renders the match-game tab (set/level selector + Start button + game area)
 * into `container`.
 */
export function renderMatchSetup(container) {
    const sets = getSets();
    const setOptions = `
        <option value="all">${t('mat.allWords')}</option>
        ${sets.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}`;
    const levelOptions = ['all', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']
        .map(l => `<option value="${l}">${l === 'all' ? t('mat.allLevels') : l}</option>`).join('');
    container.innerHTML = `
        <div class="pg-match-setup">
            <div class="pg-match-setup-title">${t('mat.title')}</div>
            <div class="pg-match-options">
                <select id="pg-match-set"   class="pg-set-select">${setOptions}</select>
                <select id="pg-match-level" class="pg-set-select">${levelOptions}</select>
            </div>
            <div id="pg-match-count" class="pg-match-count"></div>
            <button id="pg-match-start" class="pg-btn pg-btn-primary pg-btn-full" style="margin-top:10px;">${t('mat.start')}</button>
        </div>
        <div id="pg-match-game"></div>`;
    const countEl = container.querySelector('#pg-match-count');
    const startBtn = container.querySelector('#pg-match-start');
    const updateCount = () => {
        const words = _getMatchWords(container.querySelector('#pg-match-set').value, container.querySelector('#pg-match-level').value);
        const n = Math.min(words.length, 12);
        countEl.textContent = words.length >= 4
            ? t('mat.available', { total: words.length, n })
            : t('mat.notEnough', { n: words.length });
        startBtn.disabled = words.length < 4;
    };
    container.querySelector('#pg-match-set')?.addEventListener('change', updateCount);
    container.querySelector('#pg-match-level')?.addEventListener('change', updateCount);
    updateCount();
    startBtn.addEventListener('click', () => {
        const words = _getMatchWords(container.querySelector('#pg-match-set').value, container.querySelector('#pg-match-level').value);
        _startMatchGame(container.querySelector('#pg-match-game'), words);
    });
}
// ── Internal helpers ──────────────────────────────────────────────────────────
function _getMatchWords(setId, level) {
    let wb = loadWordbook();
    wb = wb.filter(w => w.level !== 'grammar' && w.level !== 'sentence');
    if (setId !== 'all')
        wb = wb.filter(w => (w.setIds || []).includes(setId));
    if (level !== 'all')
        wb = wb.filter(w => w.level === level);
    return wb;
}
function _startMatchGame(gameEl, allWords) {
    // Cap at 12 pairs, randomly selected
    const pool = shuffleArray(allWords).slice(0, 12);
    const total = pool.length;
    let matched = 0;
    let selWord = null;
    let selMean = null;
    // Shuffle word column and meaning column independently
    const wordCards = shuffleArray(pool);
    const meanCards = shuffleArray(pool);
    gameEl.innerHTML = `
        <div class="pg-match-header">
            <span id="pg-match-score">0 / ${total}</span>
            <button id="pg-match-quit" class="pg-icon-btn" title="${t('mat.quit')}"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="pg-match-grid">
            <div class="pg-match-col" id="pg-match-words">
                ${wordCards.map(w => `<div class="pg-match-card pg-match-word" data-word="${escapeHtml(w.word)}">${escapeHtml(w.word)}</div>`).join('')}
            </div>
            <div class="pg-match-col" id="pg-match-means">
                ${meanCards.map(w => `<div class="pg-match-card pg-match-mean" data-word="${escapeHtml(w.word)}">${escapeHtml(w.meaning)}</div>`).join('')}
            </div>
        </div>`;
    gameEl.querySelector('#pg-match-quit')?.addEventListener('click', () => {
        gameEl.innerHTML = '';
    });
    const updateScore = () => {
        const scoreEl = gameEl.querySelector('#pg-match-score');
        if (scoreEl)
            scoreEl.textContent = `${matched} / ${total}`;
        if (matched === total) {
            setTimeout(() => {
                gameEl.innerHTML = `<div class="pg-match-complete">${t('mat.done', { n: total })}</div>`;
            }, 600);
        }
    };
    const tryMatch = () => {
        if (!selWord || !selMean)
            return;
        const ok = selWord.dataset.word === selMean.dataset.word;
        if (ok) {
            selWord.classList.add('pg-match-correct');
            selMean.classList.add('pg-match-correct');
            matched++;
            updateScore();
            selWord = null;
            selMean = null;
        }
        else {
            selWord.classList.add('pg-match-wrong');
            selMean.classList.add('pg-match-wrong');
            const sw = selWord, sm = selMean;
            setTimeout(() => {
                sw.classList.remove('pg-match-wrong', 'pg-match-selected');
                sm.classList.remove('pg-match-wrong', 'pg-match-selected');
            }, 600);
            selWord = null;
            selMean = null;
        }
    };
    gameEl.querySelectorAll('.pg-match-word').forEach(card => {
        card.addEventListener('click', () => {
            if (card.classList.contains('pg-match-correct'))
                return;
            if (card.classList.contains('pg-match-wrong'))
                return;
            gameEl.querySelectorAll('.pg-match-word.pg-match-selected')
                .forEach(c => c.classList.remove('pg-match-selected'));
            selWord = card;
            card.classList.add('pg-match-selected');
            tryMatch();
        });
    });
    gameEl.querySelectorAll('.pg-match-mean').forEach(card => {
        card.addEventListener('click', () => {
            if (card.classList.contains('pg-match-correct'))
                return;
            if (card.classList.contains('pg-match-wrong'))
                return;
            gameEl.querySelectorAll('.pg-match-mean.pg-match-selected')
                .forEach(c => c.classList.remove('pg-match-selected'));
            selMean = card;
            card.classList.add('pg-match-selected');
            tryMatch();
        });
    });
}
