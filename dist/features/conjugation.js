// ════════════════════════════
// Polyglot  features/conjugation.ts
// ════════════════════════════
// Verb conjugation popup — DOM overlay, table renderer, and IDB cache logic.
//
// Two entry points:
//   showConjugationPopup(base, lang, deps)
//     → Called from the annotation bubble's 📊 button.
//       Always fetches from IDB first, falls back to API.
//
//   showConjugationPopupFromCache(word, deps)
//     → Called from the Wordbook list's conj button.
//       Silently re-fetches if the IDB cache is missing (e.g. after lang change).
//
// Design rules:
//   • No direct ST state reads — callModel, getLang, wordbook ops are injected.
//   • _createConjOverlay is module-private — callers use the two public fns.
//   • escapeHtml is imported directly from ui.manager (no side effects).
//
// Dependencies: constants.ts, prompts.ts, utils.ts, ui.manager.ts,
//               conj-cache.ts, wordbook.ts, types.ts
import { API } from '../constants.js';
import { verbConjugationPrompt } from '../prompts.js';
import { parseJSON } from '../utils.js';
import { escapeHtml } from '../ui.manager.js';
import { t } from '../i18n.js';
import { getConjCache, setConjCache } from '../conj-cache.js';
import { loadWordbook, saveWordbook } from '../wordbook.js';
// ── Module-level ESC handler tracker ─────────────────────────────────────────
// Only one popup can be open at a time — the handler is replaced on each open.
let _conjEscHandler = null;
// ── Internal helpers ──────────────────────────────────────────────────────────
/**
 * Creates the conjugation popup DOM and wires up close/ESC behaviour.
 * Returns { overlay, body, abort } so callers can populate body content
 * and cancel any in-flight API call when the popup is dismissed.
 */
function _createConjOverlay(base, langLabel) {
    // Dismiss any existing popup before creating a new one
    document.querySelector('.pg-conj-overlay')?.remove();
    if (_conjEscHandler) {
        document.removeEventListener('keydown', _conjEscHandler);
        _conjEscHandler = null;
    }
    const overlay = document.createElement('div');
    overlay.className = 'pg-conj-overlay';
    overlay.innerHTML = `
        <div class="pg-conj-modal" role="dialog" aria-modal="true">
            <div class="pg-conj-header">
                <span class="pg-conj-base">${escapeHtml(base)}</span>
                ${langLabel ? `<span class="pg-conj-lang-badge">${escapeHtml(langLabel)}</span>` : ''}
                <button class="pg-conj-close" title="Close" aria-label="Close"></button>
            </div>
            <div class="pg-conj-body"></div>
        </div>`;
    document.body.appendChild(overlay);
    const abortCtrl = new AbortController();
    const close = () => {
        abortCtrl.abort();
        overlay.remove();
        if (_conjEscHandler) {
            document.removeEventListener('keydown', _conjEscHandler);
            _conjEscHandler = null;
        }
    };
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) {
        e.stopPropagation();
        close();
    } });
    overlay.querySelector('.pg-conj-close').addEventListener('click', close);
    _conjEscHandler = (e) => { if (e.key === 'Escape')
        close(); };
    document.addEventListener('keydown', _conjEscHandler);
    return { overlay, body: overlay.querySelector('.pg-conj-body'), abort: abortCtrl };
}
/** Renders ConjData JSON into the popup body element. */
function _renderConjTable(body, data) {
    const { base, translation, tenses = [] } = data;
    if (!tenses.length) {
        body.className = 'pg-conj-body pg-conj-error';
        body.innerHTML = t('conj.noData');
        return;
    }
    // Update header with resolved base form + meaning badge
    const modal = body.closest('.pg-conj-modal');
    if (modal) {
        const baseEl = modal.querySelector('.pg-conj-base');
        if (baseEl)
            baseEl.textContent = base;
        if (translation && !modal.querySelector('.pg-conj-meaning')) {
            const badge = document.createElement('span');
            badge.className = 'pg-conj-meaning';
            badge.textContent = translation;
            baseEl?.insertAdjacentElement('afterend', badge);
        }
    }
    const tablesCols = tenses.map(t => `
        <div class="pg-conj-tense-col">
            <div class="pg-conj-tense-head">
                <span class="pg-conj-tense-name">${escapeHtml(t.name)}</span>
                <span class="pg-conj-tense-ko">${escapeHtml(t.name_native)}</span>
            </div>
            <table class="pg-conj-table">
                <tbody>
                    ${(t.rows || []).map(r => `
                        <tr>
                            <td class="pg-conj-person">${escapeHtml(r.person)}</td>
                            <td class="pg-conj-form">${escapeHtml(r.form)}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>`).join('');
    body.className = 'pg-conj-body';
    body.innerHTML = `<div class="pg-conj-grid">${tablesCols}</div>`;
}
function _showLoadingSpinner(body) {
    body.classList.add('pg-conj-loading');
    body.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('conj.loading')}`;
}
function _showError(body, err) {
    const msg = err instanceof Error ? err.message : String(err);
    body.className = 'pg-conj-body pg-conj-error';
    body.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${t('conj.failed', { msg: escapeHtml(msg) })}`;
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Opens the conjugation popup for a word from the annotation bubble.
 * IDB cache is checked first; falls back to a live API call.
 * Also updates the wordbook entry's conj_cached flag on successful fetch.
 */
export async function showConjugationPopup(base, lang, deps) {
    const { body, abort } = _createConjOverlay(base, lang);
    _showLoadingSpinner(body);
    try {
        // getConjCache returns ConjData | null directly (entry.data is unwrapped inside conj-cache.ts).
        const data = await getConjCache(base, lang);
        if (!data?.tenses) {
            const raw = await deps.callModel(API.sysJson, verbConjugationPrompt(base, lang, deps.getNativeLang()), abort.signal);
            if (abort.signal.aborted)
                return;
            const fetched = parseJSON(raw);
            // Persist to IDB and mark the wordbook entry as cached
            await setConjCache(base, fetched, lang);
            const wb = loadWordbook();
            const wbEntry = wb.find(e => e.word === base || e.base_form === base);
            if (wbEntry && !wbEntry.conj_cached) {
                wbEntry.conj_cached = true;
                saveWordbook(wb);
            }
            // Remove loading class regardless of whether data came from cache or API
            body.classList.remove('pg-conj-loading');
            _renderConjTable(body, fetched);
            return;
        }
        // Cache hit — render immediately
        body.classList.remove('pg-conj-loading');
        _renderConjTable(body, data);
    }
    catch (err) {
        if (abort.signal.aborted)
            return;
        _showError(body, err);
    }
}
/**
 * Opens the conjugation popup for a word from the Wordbook list.
 * Reads from IDB; silently re-fetches if the cache is missing
 * (e.g. after a language switch or manual cache clear).
 */
export async function showConjugationPopupFromCache(word, deps) {
    const lang = deps.getLang();
    const { body, abort } = _createConjOverlay(word);
    // getConjCache returns ConjData | null directly — no wrapper to unwrap.
    const cached = await getConjCache(word, lang);
    if (cached?.tenses) {
        _renderConjTable(body, cached);
        return;
    }
    // Cache miss — re-fetch silently
    _showLoadingSpinner(body);
    try {
        const raw = await deps.callModel(API.sysJson, verbConjugationPrompt(word, lang, deps.getNativeLang()), abort.signal);
        if (abort.signal.aborted)
            return;
        const data = parseJSON(raw);
        await setConjCache(word, data, lang);
        // Update conj_cached flag on wordbook entry
        const wb = loadWordbook();
        const wbEntry = wb.find(e => e.word === word || e.base_form === word);
        if (wbEntry && !wbEntry.conj_cached) {
            wbEntry.conj_cached = true;
            saveWordbook(wb);
        }
        body.classList.remove('pg-conj-loading');
        _renderConjTable(body, data);
    }
    catch (err) {
        if (abort.signal.aborted)
            return;
        _showError(body, err);
    }
}
