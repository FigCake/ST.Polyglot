// ════════════════════════════
// Polyglot  ui/tap/bubble.ts
// ════════════════════════════
// The inline translation bubble shown under a tapped sentence:
// loading skeleton → translation (+ literal, key verbs, actions) or an error.
//
// Dependencies: html.ts, i18n.ts, conj-cache.ts, runtime.ts, features/conjugation.ts,
//               ui/wordbook-ui.ts (addToWordbook), ui/tap/deep-analysis.ts
import { html, setHtml } from '../../html.js';
import { t } from '../../i18n.js';
import { getConjCache } from '../../conj-cache.js';
import { ai, getLang, getNativeLang } from '../../runtime.js';
import { showConjugationPopup } from '../../features/conjugation.js';
import { addToWordbook } from '../wordbook-ui.js';
import { rubyWord, shownReading, readingOf } from '../../furigana/word.js';
import { runDeepAnalysis, cancelDeepAnalysis } from './deep-analysis.js';
// ── Views ─────────────────────────────────────────────────────────────────────
const loadingView = html `
    <div class="pg-tap-bubble-inner pg-tap-loading">
        <div class="pg-tap-skeleton">
            <div class="pg-skeleton"></div><div class="pg-skeleton"></div><div class="pg-skeleton"></div>
        </div>
    </div>`;
const errorView = (message) => html `
    <div class="pg-tap-bubble-inner pg-tap-error"><span>${t('tap.failed', { msg: message })}</span></div>`;
const verbChip = (v, i) => html `
    <span class="pg-tap-verb-chip">
        <b>${v.form}</b><span class="pg-tap-verb-arrow">→</span>${rubyWord(v.base, shownReading(v))}
        <span class="pg-tap-verb-meaning">${v.meaning}</span>
        <button class="pg-tap-conj-btn" data-action="conjugate" data-verb="${i}" title="${t('wb.conjTable')}">📊</button>
        <button class="pg-tap-save-btn" data-action="save-verb" data-verb="${i}" title="${t('wb.addWord')}">＋</button>
    </span>`;
function resultView({ translation, literal, key_verbs = [] }) {
    return html `
        <div class="pg-tap-bubble-inner">
            <div class="pg-tap-translation">${translation}</div>
            ${literal && literal !== translation && html `<div class="pg-tap-literal">${literal}</div>`}
            ${key_verbs.length > 0 && html `<div class="pg-tap-verbs">${key_verbs.map(verbChip)}</div>`}
            <div class="pg-tap-actions">
                <button class="pg-tap-deep" data-action="deep" title="${t('tap.deepTitle')}">${t('tap.deep')}</button>
                <button class="pg-tap-save-sentence" data-action="save-sentence" title="${t('tap.saveSentenceTitle')}">${t('tap.saveSentence')}</button>
                <button class="pg-tap-close" data-action="close" title="${t('tap.close')}" aria-label="${t('tap.close')}"></button>
            </div>
        </div>`;
}
// ── Actions ───────────────────────────────────────────────────────────────────
function markDone(btn, label) {
    btn.textContent = label;
    btn.disabled = true;
}
async function saveVerb(verb, btn) {
    const base = verb.base || verb.form;
    // Attach the conjugation table when it is already cached
    const cached = await getConjCache(base, getLang()).catch(() => null);
    addToWordbook({
        word: verb.form, base_form: base, meaning: verb.meaning,
        level: verb.level ?? '', reading: readingOf(verb), conj_cache: cached ?? undefined,
    });
    markDone(btn, t('tap.saved'));
}
function bindActions(bubble, sentence, result) {
    const verbs = result.key_verbs ?? [];
    bubble.addEventListener('click', e => {
        const btn = e.target.closest('button[data-action]');
        if (!btn)
            return;
        e.stopPropagation();
        const verb = verbs[Number(btn.dataset.verb)];
        switch (btn.dataset.action) {
            case 'close':
                closeBubble(bubble);
                break;
            case 'conjugate':
                if (verb)
                    showConjugationPopup(verb.base, getLang(), { ai, getLang, getNativeLang });
                break;
            case 'save-verb':
                if (verb)
                    saveVerb(verb, btn);
                break;
            case 'save-sentence':
                addToWordbook({ word: sentence.trim().slice(0, 80), base_form: '', meaning: result.translation, level: 'sentence' });
                markDone(btn, t('wb.saved'));
                break;
            case 'deep':
                runDeepAnalysis(sentence, bubble, btn);
                break;
        }
    });
}
// ── Public API ────────────────────────────────────────────────────────────────
export function closeBubble(bubble) {
    cancelDeepAnalysis(bubble);
    bubble.remove();
}
/** The open bubble in a message, if any. */
export function bubbleIn(textEl) {
    return textEl.querySelector('.pg-tap-bubble');
}
/**
 * Shows `state` for the target sentence, replacing the message's current bubble.
 * Tapping the sentence whose bubble is already open closes it instead (returns false).
 */
export function showBubble({ textEl, anchorEl, sentence }, state) {
    const existing = bubbleIn(textEl);
    if (existing) {
        closeBubble(existing);
        if (state.kind === 'loading' && existing.dataset.sentence === sentence)
            return false;
    }
    const bubble = Object.assign(document.createElement('div'), { className: 'pg-tap-bubble' });
    bubble.dataset.sentence = sentence;
    switch (state.kind) {
        case 'loading':
            setHtml(bubble, loadingView);
            break;
        case 'error':
            setHtml(bubble, errorView(state.message));
            break;
        case 'result':
            setHtml(bubble, resultView(state.result));
            bindActions(bubble, sentence, state.result);
            break;
    }
    if (anchorEl?.parentNode === textEl)
        anchorEl.after(bubble);
    else
        textEl.appendChild(bubble);
    return true;
}
