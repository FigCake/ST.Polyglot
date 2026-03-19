// ════════════════════════════
// Polyglot  features/flashcard.ts
// ════════════════════════════
// Flashcard tab — normal browse mode + SM-2 SRS mode.
//
// Front:  word + part-of-speech + 🔊 TTS + 🎤 pronunciation check
// Back:   meaning + base form + example sentence
//
// Example sentence lifecycle:
//   1. If entry.example already exists  → show immediately (no AI call).
//   2. Else if entry.context_meaning    → derive from that (no AI call).
//   3. Else                             → call AI once on first flip,
//                                         persist to wordbook so it's
//                                         never regenerated.
//
// Design rules:
//   • All ST state / index.ts functions are injected via FlashDeps.
//   • _activeRecognition is returned to index.ts so onDismiss can abort it.
//   • No direct imports from index.ts.
//
// Dependencies: constants.ts, types.ts, prompts.ts, utils.ts,
//               ui.manager.ts, wordbook.ts, srs.ts
import { API } from '../constants.js';
import { exampleSentencePrompt } from '../prompts.js';
import { parseJSON, shuffleArray } from '../utils.js';
import { escapeHtml } from '../ui.manager.js';
import { loadWordbook, saveWordbook } from '../wordbook.js';
import { getSets } from '../wordbook.js';
import { srsRate, srsDueCount, srsPreview } from '../srs.js';
import { t } from '../i18n.js';
// ── Module-level abort for example generation ─────────────────────────────────
let _exampleAbort = null;
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Renders the full flashcard tab (set selector + SRS toggle + card area)
 * into `container`, then starts the first card.
 */
export function renderFlashcard(container, deps) {
    const sets = getSets();
    const setOptions = `
        <option value="all">${t('fl.allWords')}</option>
        ${sets.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}`;
    container.innerHTML = `
        <div class="pg-flash-controls">
            <select id="pg-flash-set" class="pg-set-select">${setOptions}</select>
            <button id="pg-flash-srs-toggle" class="pg-btn pg-btn-secondary pg-srs-toggle"
                    title="${t('fl.srsTitle')}">
                🔁 SRS <span id="pg-srs-badge" class="pg-srs-badge" style="display:none">0</span>
            </button>
            <button id="pg-flash-shuffle" class="pg-btn pg-btn-secondary" title="${t('fl.shuffle')}">🔀</button>
        </div>
        <div id="pg-flash-area"></div>`;
    const setEl = container.querySelector('#pg-flash-set');
    const srsToggle = container.querySelector('#pg-flash-srs-toggle');
    const srsBadge = container.querySelector('#pg-srs-badge');
    const shuffleEl = container.querySelector('#pg-flash-shuffle');
    const areaEl = container.querySelector('#pg-flash-area');
    let deck = [];
    let idx = 0;
    let flipped = false;
    let srsMode = false;
    let srsSessionDone = 0;
    // ── Pool helpers ──────────────────────────────────────────────────────────
    function _getPool() {
        const wb = loadWordbook();
        const setId = setEl.value;
        // Grammar patterns and full sentences are excluded from flashcard review —
        // they are stored for quiz/annotation context only.
        const vocab = wb.filter(w => w.level !== 'grammar' && w.level !== 'sentence');
        return setId === 'all' ? vocab : vocab.filter(w => (w.setIds ?? []).includes(setId));
    }
    function updateBadge(pool = _getPool()) {
        const due = srsDueCount(pool);
        if (srsBadge) {
            srsBadge.textContent = String(due);
            srsBadge.style.display = due > 0 ? '' : 'none';
        }
        srsToggle.classList.toggle('pg-srs-active', srsMode);
        if (shuffleEl)
            shuffleEl.disabled = srsMode;
    }
    function buildDeck(pool = _getPool()) {
        if (srsMode) {
            const now = Date.now();
            deck = pool
                .filter(w => (w.srs_due ?? 0) <= now)
                .sort((a, b) => (a.srs_due ?? 0) - (b.srs_due ?? 0));
        }
        else {
            deck = pool.slice();
        }
        idx = 0;
        flipped = false;
        srsSessionDone = 0;
    }
    // ── Card renderer ─────────────────────────────────────────────────────────
    function renderCard() {
        _exampleAbort?.abort();
        _exampleAbort = null;
        if (deck.length === 0) {
            if (srsMode) {
                areaEl.innerHTML = `
                    <div class="pg-srs-complete">
                        <div class="pg-srs-complete-icon">🎉</div>
                        <div class="pg-srs-complete-title">${t('fl.allDone')}</div>
                        <div class="pg-srs-complete-sub">
                            ${t('fl.allDoneSub', { n: srsSessionDone })}
                        </div>
                        <button id="pg-srs-back-all" class="pg-btn pg-btn-secondary pg-btn-full">
                            ${t('fl.backAll')}
                        </button>
                    </div>`;
                areaEl.querySelector('#pg-srs-back-all')?.addEventListener('click', () => {
                    srsMode = false;
                    const pool = _getPool();
                    buildDeck(pool);
                    updateBadge(pool);
                    renderCard();
                });
            }
            else {
                areaEl.innerHTML = `<div class="pg-empty-hint">${t('fl.noWords').replace(/\n/g, '<br>')}</div>`;
            }
            return;
        }
        const w = deck[idx];
        const interval = w.srs_interval ?? 1;
        const ease = w.srs_ease ?? 2.5;
        const prog = srsMode
            ? `${t('fl.remaining', { n: deck.length })} &nbsp;·&nbsp; ${t('fl.doneSess', { n: srsSessionDone })}`
            : `${idx + 1} / ${deck.length}`;
        const ratingHtml = (srsMode && flipped) ? `
            <div class="pg-srs-rating">
                <button class="pg-srs-btn pg-srs-again" data-rating="0">
                    <span class="pg-srs-label">${t('fl.again')}</span>
                    <span class="pg-srs-preview">${srsPreview(interval, ease, 0)}</span>
                </button>
                <button class="pg-srs-btn pg-srs-hard" data-rating="1">
                    <span class="pg-srs-label">${t('fl.hard')}</span>
                    <span class="pg-srs-preview">${srsPreview(interval, ease, 1)}</span>
                </button>
                <button class="pg-srs-btn pg-srs-good" data-rating="2">
                    <span class="pg-srs-label">${t('fl.good')}</span>
                    <span class="pg-srs-preview">${srsPreview(interval, ease, 2)}</span>
                </button>
                <button class="pg-srs-btn pg-srs-easy" data-rating="3">
                    <span class="pg-srs-label">${t('fl.easy')}</span>
                    <span class="pg-srs-preview">${srsPreview(interval, ease, 3)}</span>
                </button>
            </div>` : '';
        const navHtml = !srsMode ? `
            <div class="pg-flash-nav">
                <button id="pg-flash-prev" class="pg-btn pg-btn-secondary" ${idx === 0 ? 'disabled' : ''}>${t('fl.prev')}</button>
                <button id="pg-flash-flip" class="pg-btn pg-btn-primary">${flipped ? t('fl.showWord') : t('fl.showMeaning')}</button>
                <button id="pg-flash-next" class="pg-btn pg-btn-secondary" ${idx === deck.length - 1 ? 'disabled' : ''}>${t('fl.next')}</button>
            </div>` : '';
        const hintText = srsMode
            ? (flipped ? '' : t('fl.clickReveal'))
            : (flipped ? '' : t('fl.tapReveal'));
        // ── Back-face example: already cached, derived, or placeholder for lazy load
        const backExampleHtml = _buildBackExample(w, flipped);
        areaEl.innerHTML = `
            <div class="pg-flash-progress">${prog}</div>
            <div class="pg-flash-card ${flipped ? 'pg-flash-flipped' : ''}" id="pg-flash-card">
                <div class="pg-flash-front">
                    <div class="pg-flash-word">${escapeHtml(w.word)}</div>
                    ${w.pos_info ? `<div class="pg-flash-pos">${escapeHtml(w.pos_info)}</div>` : ''}
                    <div class="pg-flash-btn-row">
                        <button class="pg-speak-btn pg-flash-speak" title="${t('fl.listen')}">🔊</button>
                        ${deps.hasSpeechRecog()
            ? `<button class="pg-flash-mic" title="${t('fl.mic')}" data-active="false">🎤</button>`
            : ''}
                    </div>
                </div>
                <div class="pg-flash-back">
                    <div class="pg-flash-meaning">${escapeHtml(w.meaning)}</div>
                    ${w.base_form && w.base_form !== w.word
            ? `<div class="pg-flash-pos">${escapeHtml(w.base_form)}</div>` : ''}
                    ${w.context_meaning && w.context_meaning !== w.meaning
            ? `<div class="pg-flash-ctx">${escapeHtml(w.context_meaning)}</div>` : ''}
                    ${backExampleHtml}
                    ${w.notes
            ? `<div class="pg-flash-notes">${escapeHtml(w.notes)}</div>`
            : ''}
                </div>
            </div>
            <div class="pg-pronun-result" id="pg-pronun-result"></div>
            <div class="pg-flash-hint">${hintText}</div>
            ${ratingHtml}
            ${navHtml}`;
        // Lazy-load example sentence if needed
        if (flipped && !w.example) {
            _loadExample(w, areaEl, deps);
        }
        // ── Event bindings ────────────────────────────────────────────────────
        const abortRecog = () => {
            const r = deps.getActiveRecog();
            if (r) {
                r.abort();
                deps.setActiveRecog(null);
            }
        };
        areaEl.querySelector('#pg-flash-card')?.addEventListener('click', () => {
            abortRecog();
            flipped = !flipped;
            renderCard();
        });
        areaEl.querySelector('#pg-flash-flip')?.addEventListener('click', e => {
            e.stopPropagation();
            abortRecog();
            flipped = !flipped;
            renderCard();
        });
        areaEl.querySelector('#pg-flash-prev')?.addEventListener('click', e => {
            e.stopPropagation();
            abortRecog();
            if (idx > 0) {
                idx--;
                flipped = false;
                renderCard();
            }
        });
        areaEl.querySelector('#pg-flash-next')?.addEventListener('click', e => {
            e.stopPropagation();
            abortRecog();
            if (idx < deck.length - 1) {
                idx++;
                flipped = false;
                renderCard();
            }
        });
        // SRS rating buttons
        areaEl.querySelectorAll('.pg-srs-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                abortRecog();
                const rating = parseInt(btn.dataset.rating ?? '0');
                const wb = loadWordbook();
                const target = wb.find(en => en.word === w.word);
                if (!target)
                    return;
                const requeue = srsRate(target, rating);
                saveWordbook(wb);
                deck.splice(idx, 1);
                if (requeue)
                    deck.push(target);
                else
                    srsSessionDone++;
                if (idx >= deck.length)
                    idx = Math.max(0, deck.length - 1);
                flipped = false;
                updateBadge();
                renderCard();
            });
        });
        // 🔊 TTS
        areaEl.querySelector('.pg-flash-speak')?.addEventListener('click', e => {
            e.stopPropagation();
            deps.speak(w.word, deps.getLang());
        });
        // 🎤 Pronunciation check
        const micBtn = areaEl.querySelector('.pg-flash-mic');
        const resultEl = areaEl.querySelector('#pg-pronun-result');
        if (micBtn && resultEl) {
            micBtn.addEventListener('click', e => {
                e.stopPropagation();
                if (micBtn.dataset.active === 'true') {
                    abortRecog();
                    return;
                }
                deps.setActiveRecog(deps.runPronunCheck(w.word, micBtn, resultEl));
            });
        }
    } // ─ end renderCard
    // ── Control events ────────────────────────────────────────────────────────
    srsToggle.addEventListener('click', () => {
        srsMode = !srsMode;
        const pool = _getPool();
        buildDeck(pool);
        updateBadge(pool);
        renderCard();
    });
    setEl.addEventListener('change', () => {
        const pool = _getPool();
        buildDeck(pool);
        updateBadge(pool);
        renderCard();
    });
    shuffleEl?.addEventListener('click', () => {
        if (srsMode)
            return;
        buildDeck();
        deck = shuffleArray(deck);
        renderCard();
    });
    const initPool = _getPool();
    buildDeck(initPool);
    updateBadge(initPool);
    renderCard();
}
// ── Internal: back-face example HTML builder ──────────────────────────────────
/**
 * Returns the HTML for the example sentence area on the card back.
 *
 * • If `flipped` is false  → empty string (back not visible yet).
 * • If entry.example set   → render immediately.
 * • Else                   → render a loading placeholder (AI will fill it in).
 */
function _buildBackExample(w, flipped) {
    if (!flipped)
        return '';
    // Already persisted — show sentence + translation (translation toggle via click)
    if (w.example) {
        const transHtml = w.example_translation
            ? `<div class="pg-flash-example-trans">${escapeHtml(w.example_translation)}</div>`
            : '';
        return `<div class="pg-flash-example-wrap">
                    <div class="pg-flash-example">${escapeHtml(w.example)}</div>
                    ${transHtml}
                </div>`;
    }
    // Placeholder — _loadExample() will replace this via AI call
    return `<div class="pg-flash-example-wrap">
                <div class="pg-flash-example pg-flash-example-loading" id="pg-flash-example-slot">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                </div>
            </div>`;
}
/**
 * Lazily generates and persists an example sentence for a wordbook entry.
 * Replaces the #pg-flash-example-slot element in place once ready.
 */
async function _loadExample(w, areaEl, deps) {
    _exampleAbort?.abort();
    const abort = new AbortController();
    _exampleAbort = abort;
    const slot = areaEl.querySelector('#pg-flash-example-slot');
    try {
        const s = deps.getSettings();
        const lang = deps.getLang();
        const native = deps.getNativeLang();
        const raw = await deps.callModel(API.sysJson, exampleSentencePrompt(w.base_form || w.word, lang, s.cefr_level, native), abort.signal);
        if (abort.signal.aborted)
            return;
        const result = parseJSON(raw);
        const sentence = result.sentence?.trim();
        const translation = result.translation?.trim();
        if (!sentence)
            return;
        // Persist — load fresh to avoid overwriting concurrent SRS changes
        const wb = loadWordbook();
        const entry = wb.find(e => e.word === w.word);
        if (entry) {
            entry.example = sentence;
            if (translation)
                entry.example_translation = translation;
            saveWordbook(wb);
            // Also update the live deck reference so re-renders use the cached value
            w.example = sentence;
            if (translation)
                w.example_translation = translation;
        }
        // Update DOM in place
        if (slot && document.contains(slot)) {
            slot.id = '';
            slot.className = 'pg-flash-example';
            slot.textContent = sentence;
            // Append translation below if present
            if (translation) {
                const transEl = document.createElement('div');
                transEl.className = 'pg-flash-example-trans';
                transEl.textContent = translation;
                slot.after(transEl);
            }
        }
    }
    catch {
        if (abort.signal.aborted)
            return;
        if (slot && document.contains(slot)) {
            slot.id = '';
            slot.className = 'pg-flash-example pg-flash-example-err';
            slot.textContent = '—';
        }
    }
    finally {
        if (_exampleAbort === abort)
            _exampleAbort = null;
    }
}
