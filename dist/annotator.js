// ════════════════════════════
// Polyglot  annotator.ts
// ════════════════════════════
// Annotation persistence, highlight rendering, and DOM observation.
//
// Design rules:
//   • No dependency on index.ts.  getSettings/getLang/callModel are handled
//     locally (same pattern as wordbook.ts).
//   • openLearningPanel is injected at init time via setOpenPanelFn() to
//     avoid a circular dependency with the panel/ui layer.
//   • annotateAborts lives here (purely annotator state).
//
// Dependencies: constants.ts, types.ts, utils.ts, prompts.ts, ui.manager.ts,
//               ST internals (extension_settings, saveMetadataDebounced, getContext,
//               saveSettingsDebounced)
import { KEY, DELAY, API } from './constants.js';
import { parseJSON, levelClass, getLangFromSettings, getNativeLangFromSettings } from './utils.js';
import { annotatorPrompt } from './prompts.js';
import { notify } from './ui.manager.js';
import { callModel as _apiCallModel } from './api.js';
import { t } from './i18n.js';
import { loadWordbook, addToWordbook } from './wordbook.js';
// @ts-expect-error — no type declarations for ST internals
import { extension_settings, saveMetadataDebounced, getContext } from '../../../../extensions.js';
// @ts-expect-error — no type declarations for ST internals
import { saveSettingsDebounced } from '../../../../../script.js';
// ── Private helpers (mirror index.ts patterns) ────────────────────────────────
function _getSettings() { return extension_settings[KEY.module]; }
function _save() { saveSettingsDebounced(); }
function _getLang() { return getLangFromSettings(_getSettings()); }
function _getNativeLang() { return getNativeLangFromSettings(_getSettings()); }
function _callModel(sys, user, signal) {
    return _apiCallModel(_getSettings(), sys, user, signal);
}
// ── Injected dependency — set by index.ts at init ────────────────────────────
/** Called when a highlight span is clicked or the 🌍 button is pressed. */
let _openPanelFn = () => { };
/** Register the openLearningPanel function from the panel/ui layer. */
export function setOpenPanelFn(fn) {
    _openPanelFn = fn;
}
// ════════════════════════════
// Module state
// ════════════════════════════
export const annotatedMsgs = new Set();
export const annotationCache = new Map();
export const mesObservers = new Map();
export const annotateAborts = new Map();
let _restoreCancelled = false;
let _clearingAnnotations = false; // when true, restoreAnnotations() is a no-op
// ── Module-level regex constant ───────────────────────────────────────────────
// Declared here (not inside renderAnnotation) so the RegExp object is created
// once per module load, not once per text node processed.
/** Matches any Unicode letter or digit — used to detect word-boundary overlap. */
const _WORD_CHAR = /\p{L}|\p{N}/u;
// ════════════════════════════
// Chat key
// ════════════════════════════
export function getChatKey() {
    return getContext().chatId ?? null;
}
// ════════════════════════════
// Annotation persistence
// ════════════════════════════
/** Returns a live reference to the annotation map, creating it if absent.
 *  Returns null when chatMetadata is unavailable (no chat loaded). */
function _getAnnotationStore(create) {
    const ctx = getContext();
    if (!ctx?.chatMetadata)
        return null;
    if (create && !ctx.chatMetadata[KEY.annotations]) {
        ctx.chatMetadata[KEY.annotations] = {};
    }
    const store = ctx.chatMetadata[KEY.annotations];
    return (store && typeof store === 'object') ? store : null;
}
export function persistAnnotation(mesId, result) {
    const store = _getAnnotationStore(true);
    if (!store)
        return;
    store[mesId] = result;
    _saveAnnotations();
}
export function unpersistAnnotation(mesId) {
    const store = _getAnnotationStore(false);
    if (!store)
        return;
    delete store[mesId];
    _saveAnnotations();
}
function _saveAnnotations() {
    if (typeof saveMetadataDebounced === 'function') {
        saveMetadataDebounced();
        return;
    }
    const ctx = getContext();
    if (typeof ctx?.saveMetadata === 'function')
        ctx.saveMetadata();
    else if (typeof ctx?.saveMetadataDebounced === 'function')
        ctx.saveMetadataDebounced();
}
// ════════════════════════════
// Restore annotations
// ════════════════════════════
/** Restores saved annotations for the current chat into the DOM. */
export function restoreAnnotations() {
    if (_clearingAnnotations)
        return;
    if (!_getSettings().enabled_annotator)
        return;
    const stored = _getAnnotationStore(false);
    if (!stored || Object.keys(stored).length === 0)
        return;
    for (const [mesId, result] of Object.entries(stored)) {
        const msgEl = document.querySelector(`.mes[mesid="${CSS.escape(mesId)}"]`);
        if (!msgEl)
            continue;
        const textEl = msgEl.querySelector('.mes_text');
        if (!textEl)
            continue;
        if (annotatedMsgs.has(mesId))
            continue;
        annotationCache.set(mesId, result);
        renderAnnotation(msgEl, textEl, result, mesId);
        annotatedMsgs.add(mesId);
        observeMesText(msgEl, mesId);
        msgEl.querySelector('.pg-annotate-btn')?.classList.add('pg-btn-active');
    }
}
/**
 * Retries annotation restoration after chat load.
 * ST renders messages asynchronously — retries for up to DELAY.restoreDeadline ms.
 */
export function restoreWithRetry() {
    const stored = _getAnnotationStore(false);
    if (!stored || Object.keys(stored).length === 0)
        return;
    _restoreCancelled = false;
    const pending = new Set(Object.keys(stored));
    const deadline = performance.now() + DELAY.restoreDeadline;
    function attempt() {
        if (_restoreCancelled)
            return;
        for (const mesId of [...pending]) {
            if (annotatedMsgs.has(mesId)) {
                pending.delete(mesId);
                continue;
            }
            const msgEl = document.querySelector(`.mes[mesid="${CSS.escape(mesId)}"]`);
            if (msgEl?.querySelector('.mes_text'))
                pending.delete(mesId);
        }
        restoreAnnotations();
        if (pending.size > 0 && performance.now() < deadline)
            setTimeout(attempt, DELAY.animFrame);
    }
    setTimeout(attempt, DELAY.animFrame);
}
// ════════════════════════════
// Clear annotations
// ════════════════════════════
/** Replaces pg-clickable-word spans with plain text without touching innerHTML. */
export function stripHighlightsFromEl(textEl) {
    textEl.querySelectorAll('.pg-clickable-word').forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent ?? ''));
    });
    textEl.normalize();
}
function _clearAnnotationDOM() {
    mesObservers.forEach(e => { e.cancel(); });
    mesObservers.clear();
    annotatedMsgs.clear();
    annotationCache.clear();
    document.querySelectorAll('.mes_text').forEach(el => stripHighlightsFromEl(el));
    document.querySelectorAll('.pg-annotate-btn').forEach(b => b.classList.remove('pg-btn-active'));
}
export function clearCurrentChatAnnotations() {
    _restoreCancelled = true;
    _clearingAnnotations = true;
    const store = _getAnnotationStore(false);
    if (store) {
        const ctx = getContext();
        if (ctx?.chatMetadata) {
            delete ctx.chatMetadata[KEY.annotations];
            _saveAnnotations();
        }
    }
    _clearAnnotationDOM();
    setTimeout(() => { _clearingAnnotations = false; }, 0);
}
export function clearAllAnnotations() {
    _restoreCancelled = true;
    _clearingAnnotations = true;
    clearCurrentChatAnnotations();
    // NOTE: _clearingAnnotations is reset to false by the setTimeout inside
    // clearCurrentChatAnnotations(). A second setTimeout here would create a
    // race: the first fires and sets _clearingAnnotations = false while the
    // second clear operation may not have finished, allowing restoreAnnotations()
    // to run prematurely and resurrect annotations we just deleted.
    // Purge any legacy _annotations still lingering in extension_settings
    const s = _getSettings();
    if (s._annotations) {
        delete s._annotations;
        _save();
    }
}
// ════════════════════════════
// Snackbar
// ════════════════════════════
export function showAnnotateSnackbar(onStop) {
    removeAnnotateSnackbar();
    const el = document.createElement('div');
    el.id = 'pg-snackbar';
    el.className = 'pg-snackbar';
    el.innerHTML = `
        <span class="pg-snackbar-text"><i class="fa-solid fa-spinner fa-spin"></i>&nbsp; ${t('ann.analysing')}</span>
        <button class="pg-snackbar-stop">${t('ann.stop')}</button>`;
    el.querySelector('.pg-snackbar-stop')?.addEventListener('click', () => { onStop(); removeAnnotateSnackbar(); });
    document.body.appendChild(el);
    void el.offsetWidth; // force reflow so CSS transition fires on mobile
    el.classList.add('pg-snackbar-visible');
}
export function removeAnnotateSnackbar() {
    const el = document.getElementById('pg-snackbar');
    if (!el)
        return;
    el.classList.remove('pg-snackbar-visible');
    setTimeout(() => el.remove(), DELAY.snackbarFadeOut);
}
// ════════════════════════════
// Run annotator
// ════════════════════════════
export function injectAnnotateButtons() {
    if (!_getSettings().enabled_annotator)
        return; // hidden when annotator is disabled
    document.querySelectorAll('.mes[is_user="false"]').forEach(msgEl => {
        const mesId = msgEl.getAttribute('mesid');
        if (!mesId || msgEl.querySelector('.pg-annotate-btn'))
            return;
        const extraBtns = msgEl.querySelector('.extraMesButtons');
        if (!extraBtns)
            return;
        const panelBtn = document.createElement('div');
        panelBtn.className = 'mes_button pg-open-btn fa-solid fa-earth-europe interactable';
        panelBtn.setAttribute('title', 'Open Polyglot panel');
        panelBtn.setAttribute('tabindex', '0');
        panelBtn.addEventListener('click', () => _openPanelFn('detail', null));
        extraBtns.prepend(panelBtn);
        const annotateBtn = document.createElement('div');
        annotateBtn.className = 'mes_button pg-annotate-btn fa-solid fa-book-open interactable';
        annotateBtn.setAttribute('title', 'Polyglot: annotate for study');
        annotateBtn.setAttribute('tabindex', '0');
        annotateBtn.addEventListener('click', () => runAnnotator(msgEl, mesId));
        extraBtns.prepend(annotateBtn);
    });
}
export async function runAnnotator(msgEl, mesId) {
    if (!_getSettings().enabled_annotator)
        return;
    if (annotateAborts.has(mesId))
        return;
    if (annotatedMsgs.has(mesId)) {
        removeAnnotation(msgEl, mesId);
        return;
    }
    const textEl = msgEl.querySelector('.mes_text');
    if (!textEl)
        return;
    const startChatKey = getChatKey();
    const btn = msgEl.querySelector('.pg-annotate-btn');
    if (btn)
        btn.classList.add('pg-btn-busy');
    const abort = new AbortController();
    annotateAborts.set(mesId, abort);
    showAnnotateSnackbar(() => { abort.abort(); if (btn)
        btn.classList.remove('pg-btn-busy'); });
    try {
        const result = parseJSON(await _callModel(API.sysJson, annotatorPrompt(textEl.innerText || '', _getLang(), _getSettings().cefr_level, _getNativeLang()), abort.signal));
        if (abort.signal.aborted)
            return;
        if (startChatKey !== getChatKey())
            return; // chat changed while waiting
        if (!result || typeof result !== 'object')
            throw new Error('Unexpected AI response format.');
        annotationCache.set(mesId, result);
        renderAnnotation(msgEl, textEl, result, mesId);
        annotatedMsgs.add(mesId);
        observeMesText(msgEl, mesId);
        persistAnnotation(mesId, result);
        // Save detected idioms to wordbook as level:'idiom' entries (skip duplicates silently)
        const idioms = result.idioms ?? [];
        if (idioms.length > 0 && _getSettings().auto_save_idioms !== false) {
            const nativeLang = _getNativeLang();
            const wb = loadWordbook();
            let dirty = false;
            for (const id of idioms) {
                if (!id.phrase?.trim() || !id.meaning?.trim())
                    continue;
                const canonical = id.base_form?.trim() || id.phrase.trim();
                if (wb.find(w => w.word === canonical))
                    continue; // already saved
                addToWordbook({
                    word: id.phrase,
                    base_form: canonical,
                    meaning: id.meaning,
                    meaning_lang: nativeLang,
                    level: 'idiom',
                    context_meaning: id.context_meaning,
                });
                dirty = true;
            }
            if (dirty)
                notify(t('ann.idiomsAdded', { n: idioms.length }), 'info', 2500);
        }
        if (btn) {
            btn.classList.remove('pg-btn-busy');
            btn.classList.add('pg-btn-active');
        }
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        console.error('[Polyglot] Annotation error:', e);
        if (btn)
            btn.classList.remove('pg-btn-busy');
        notify(t('ann.error', { msg: e instanceof Error ? e.message : String(e) }), 'err', 3000);
    }
    finally {
        annotateAborts.delete(mesId);
        removeAnnotateSnackbar();
    }
}
export function removeAnnotation(msgEl, mesId) {
    const entry = mesObservers.get(mesId);
    if (entry) {
        entry.cancel();
        mesObservers.delete(mesId);
    }
    annotationCache.delete(mesId);
    const textEl = msgEl.querySelector('.mes_text');
    if (textEl)
        stripHighlightsFromEl(textEl);
    annotatedMsgs.delete(mesId);
    msgEl.querySelector('.pg-annotate-btn')?.classList.remove('pg-btn-active');
    unpersistAnnotation(mesId);
}
// ════════════════════════════
// Render annotation
// ════════════════════════════
export function renderAnnotation(msgEl, textEl, data, _mesId) {
    // Build item list sorted by length descending (longer phrases match first)
    const items = [
        ...(data.hard_words || []).map(w => ({ type: 'word', text: w.word, data: w })),
        ...(data.grammar_patterns || []).map(g => ({ type: 'grammar', text: g.pattern, data: g })),
        ...(data.idioms || []).map(i => ({ type: 'idiom', text: i.phrase, data: i })),
    ].sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0));
    // Unicode word-character test (supports non-ASCII like Spanish é, Japanese, etc.)
    // Uses the module-level _WORD_CHAR constant — defined once, not per call.
    function annotateTextNode(textNode) {
        const parent = textNode.parentNode;
        if (parent?.classList?.contains('pg-clickable-word'))
            return;
        let remaining = textNode.textContent;
        if (!remaining.trim())
            return;
        const frag = document.createDocumentFragment();
        let matched = false;
        while (remaining.length > 0) {
            let bestIdx = -1, bestItem = null;
            for (const item of items) {
                if (!item.text)
                    continue;
                let searchFrom = 0;
                while (searchFrom < remaining.length) {
                    const idx = remaining.indexOf(item.text, searchFrom);
                    if (idx === -1)
                        break;
                    const before = remaining[idx - 1];
                    const after = remaining[idx + item.text.length];
                    if ((before && _WORD_CHAR.test(before)) || (after && _WORD_CHAR.test(after))) {
                        searchFrom = idx + 1;
                        continue;
                    }
                    if (bestIdx === -1 || idx < bestIdx) {
                        bestIdx = idx;
                        bestItem = item;
                    }
                    break;
                }
            }
            if (bestIdx === -1 || !bestItem) {
                frag.appendChild(document.createTextNode(remaining));
                break;
            }
            if (bestIdx > 0)
                frag.appendChild(document.createTextNode(remaining.slice(0, bestIdx)));
            const level = bestItem.type === 'word' ? bestItem.data.level : undefined;
            // levelClass() maps A*→'A1'…, B*→'B1'…, C*→'C1'…; first char lowercased gives the CSS suffix.
            // When level is absent on a word entry, default to 'c' (hardest tier) rather than 'grammar'.
            const lvCls = levelClass(level);
            const cls = bestItem.type === 'idiom'
                ? 'pg-hl-idiom'
                : bestItem.type === 'grammar'
                    ? 'pg-hl-grammar'
                    : (lvCls === 'grammar' || lvCls === 'sentence')
                        ? 'pg-hl-c'
                        : `pg-hl-${lvCls[0].toLowerCase()}`;
            const span = document.createElement('span');
            span.className = `pg-clickable-word ${cls}`;
            span.dataset.wordinfo = JSON.stringify(bestItem);
            span.textContent = bestItem.text;
            span.addEventListener('click', () => {
                try {
                    _openPanelFn('detail', parseJSON(span.dataset.wordinfo ?? ''));
                }
                catch { /* malformed wordinfo — ignore */ }
            });
            frag.appendChild(span);
            remaining = remaining.slice(bestIdx + bestItem.text.length);
            matched = true;
        }
        if (matched && parent)
            parent.replaceChild(frag, textNode);
    }
    function collectTextNodes(node, result = []) {
        if (node.nodeType === Node.TEXT_NODE) {
            result.push(node);
            return result;
        }
        if (node.nodeType !== Node.ELEMENT_NODE)
            return result;
        const elNode = node;
        if (['SCRIPT', 'STYLE', 'CODE', 'PRE'].includes(elNode.tagName))
            return result;
        if (elNode.classList?.contains('pg-clickable-word'))
            return result;
        node.childNodes.forEach(c => collectTextNodes(c, result));
        return result;
    }
    collectTextNodes(textEl).forEach(annotateTextNode);
}
// ════════════════════════════
// MutationObserver — re-annotate on ST innerHTML replacement
// ════════════════════════════
// Maximum number of times the observer will re-annotate a single message.
// ST occasionally replaces innerHTML during streaming or swiping, but
// repeated re-annotations beyond this threshold indicate an abnormal loop.
const MAX_RE_ANNOTATIONS = 20;
export function observeMesText(msgEl, mesId) {
    if (mesObservers.has(mesId))
        return;
    const textEl = msgEl.querySelector('.mes_text');
    if (!textEl)
        return;
    let retryTimer = null;
    let reAnnotationCount = 0;
    const obs = new MutationObserver(() => {
        if (textEl.querySelector('.pg-clickable-word'))
            return;
        if (textEl.querySelector('.pg-tap-bubble'))
            return;
        const cached = annotationCache.get(mesId);
        if (!cached)
            return;
        // Safety: stop re-annotating if we've exceeded the retry limit.
        // This prevents runaway loops if ST keeps replacing the message DOM.
        if (reAnnotationCount >= MAX_RE_ANNOTATIONS) {
            obs.disconnect();
            console.warn('[Polyglot] observeMesText: max re-annotation limit reached for mesId:', mesId);
            return;
        }
        reAnnotationCount++;
        obs.disconnect();
        renderAnnotation(msgEl, textEl, cached, mesId);
        // Use requestAnimationFrame instead of a fixed 100ms delay so we
        // resume observing as soon as the browser finishes its next paint —
        // minimising the window during which a second DOM replacement would
        // go undetected, without hardcoding an arbitrary timeout.
        retryTimer = requestAnimationFrame(() => {
            retryTimer = null;
            obs.observe(textEl, { childList: true, subtree: true });
        });
    });
    obs.observe(textEl, { childList: true, subtree: true });
    mesObservers.set(mesId, {
        obs,
        get timer() { return retryTimer; },
        cancel() {
            obs.disconnect();
            if (retryTimer !== null) {
                cancelAnimationFrame(retryTimer);
                retryTimer = null;
            }
        },
    });
}
// ════════════════════════════
// Migration
// ════════════════════════════
