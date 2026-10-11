// Verb conjugation popup: a modal overlay showing one table per tense.
//
// Tables come from the IndexedDB cache when present, otherwise from the AI
// (then cached, and the wordbook entry is flagged `conj_cached`).
//
// Entry points:
//   showConjugationPopup(base, lang, deps)    annotation bubble 📊 button (shows a language badge)
//   showConjugationPopupFromCache(word, deps) wordbook row button
//
// Design rules:
//   • No direct ST state reads — the AI client and language getters are injected.
//   • Only one popup exists at a time; opening a new one closes the previous.
import { verbConjugationPrompt } from '../prompts.js';
import { html, setHtml } from '../html.js';
import { t } from '../i18n.js';
import { getConjCache, setConjCache } from '../conj-cache.js';
import { loadWordbook, saveWordbook } from '../wordbook.js';
import { isRecord } from '../ai/client.js';
// ── Data ──────────────────────────────────────────────────────────────────────
/** Accepts a table with at least one tense; drops tenses without rows. */
function acceptConjData(v) {
    if (!isRecord(v) || !Array.isArray(v.tenses))
        return null;
    const tenses = v.tenses.filter(tn => isRecord(tn) && Array.isArray(tn.rows) && tn.rows.length);
    if (!tenses.length)
        return null;
    return { base: String(v.base ?? ''), translation: String(v.translation ?? ''), tenses };
}
/** Cached table, or a freshly generated (and then cached) one. */
async function loadConjugation(word, lang, deps, signal) {
    const cached = await getConjCache(word, lang);
    if (cached?.tenses?.length)
        return cached;
    const { data, partial } = await deps.ai.json({
        prompt: verbConjugationPrompt(word, lang, deps.getNativeLang()),
        signal,
        accept: acceptConjData,
    });
    // A table from a cut-off reply is shown but not kept, so the next look asks again
    if (partial)
        return data;
    await setConjCache(word, data, lang);
    markCached(word);
    return data;
}
function markCached(word) {
    const wordbook = loadWordbook();
    const entry = wordbook.find(e => e.word === word || e.base_form === word);
    if (entry && !entry.conj_cached) {
        entry.conj_cached = true;
        saveWordbook(wordbook);
    }
}
let closeCurrent = null;
/** Opens the modal (closing any previous one). Closing it cancels the pending request. */
function openPopup(title, badge) {
    closeCurrent?.();
    const overlay = document.createElement('div');
    overlay.className = 'pg-conj-overlay';
    setHtml(overlay, html `
        <div class="pg-conj-modal" role="dialog" aria-modal="true" aria-label="${title}">
            <div class="pg-conj-header">
                <span class="pg-conj-base">${title}</span>
                ${badge && html `<span class="pg-conj-lang-badge">${badge}</span>`}
                <button class="pg-conj-close" title="Close" aria-label="Close"></button>
            </div>
            <div class="pg-conj-body"></div>
        </div>`);
    document.body.appendChild(overlay);
    const abort = new AbortController();
    // Capture, and stop it there: the Escape closes this popup, not the panel under it
    const onKey = (e) => { if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close();
    } };
    const close = () => {
        abort.abort();
        overlay.remove();
        window.removeEventListener('keydown', onKey, true);
        if (closeCurrent === close)
            closeCurrent = null;
    };
    closeCurrent = close;
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) {
        e.stopPropagation();
        close();
    } });
    overlay.querySelector('.pg-conj-close')?.addEventListener('click', close);
    window.addEventListener('keydown', onKey, true);
    return { body: overlay.querySelector('.pg-conj-body'), signal: abort.signal };
}
function setBody(body, state, content) {
    body.className = state === 'ready' ? 'pg-conj-body' : `pg-conj-body pg-conj-${state}`;
    setHtml(body, content);
}
function renderTable(body, { base, translation, tenses }) {
    // The resolved base form and its meaning replace the clicked surface form in the header
    const header = body.closest('.pg-conj-modal');
    const baseEl = header?.querySelector('.pg-conj-base');
    if (baseEl && base)
        baseEl.textContent = base;
    if (baseEl && translation && !header?.querySelector('.pg-conj-meaning')) {
        baseEl.insertAdjacentElement('afterend', Object.assign(document.createElement('span'), { className: 'pg-conj-meaning', textContent: translation }));
    }
    setBody(body, 'ready', html `
        <div class="pg-conj-grid">${tenses.map(tense => html `
            <div class="pg-conj-tense-col">
                <div class="pg-conj-tense-head">
                    <span class="pg-conj-tense-name">${tense.name}</span>
                    <span class="pg-conj-tense-ko">${tense.name_native}</span>
                </div>
                <table class="pg-conj-table"><tbody>${(tense.rows ?? []).map(r => html `
                    <tr><td class="pg-conj-person">${r.person}</td><td class="pg-conj-form">${r.form}</td></tr>`)}
                </tbody></table>
            </div>`)}
        </div>`);
}
async function show(word, lang, deps, badge) {
    const { body, signal } = openPopup(word, badge);
    setBody(body, 'loading', html `<i class="fa-solid fa-spinner fa-spin"></i> ${t('conj.loading')}`);
    try {
        renderTable(body, await loadConjugation(word, lang, deps, signal));
    }
    catch (err) {
        if (signal.aborted)
            return;
        const msg = err instanceof Error ? err.message : String(err);
        setBody(body, 'error', html `<i class="fa-solid fa-triangle-exclamation"></i> ${t('conj.failed', { msg })}`);
    }
}
// ── Public API ────────────────────────────────────────────────────────────────
/** From the annotation bubble: shows the language as a badge. */
export function showConjugationPopup(base, lang, deps) {
    return show(base, lang, deps, lang);
}
/** From a wordbook row: uses the current study language. */
export function showConjugationPopupFromCache(word, deps) {
    return show(word, deps.getLang(), deps);
}
