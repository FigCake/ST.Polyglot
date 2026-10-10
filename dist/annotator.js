// ════════════════════════════
// Polyglot  annotator.ts
// ════════════════════════════
// Message annotation: asks the AI for hard words, grammar patterns and idioms
// in a message, highlights them in place, and keeps them across re-renders.
//
// Lifecycle of one message:
//   📖 click → runAnnotator → 'annotation' layer (ui/message-decor.ts) → persist (chat metadata)
//            └ in parallel, Japanese with furigana on: readings (furigana/messages.ts)
//   📖 again → removeAnnotation (and its readings)   swipe → forgetMessage   chat switch → resetChatState
//
// The decor layer redraws the highlights when ST re-renders the text, and
// keeps them underneath furigana.
//
// Design rules:
//   • openLearningPanel is injected (setOpenPanelFn) — the panel layer imports
//     this module's neighbours, so importing it here would create a cycle.
//   • Highlighting only wraps text nodes; it never rewrites the message HTML.
//   • Message text is read through plain-text.ts (no furigana readings).
//
// Dependencies: constants.ts, types.ts, utils.ts, prompts.ts, ui.manager.ts,
//               html.ts, i18n.ts, wordbook.ts, storage.ts, runtime.ts, ai/client.ts,
//               plain-text.ts, ui/message-decor.ts
import { KEY, DELAY } from './constants.js';
import { levelClass, findWord } from './utils.js';
import { annotatorPrompt } from './prompts.js';
import { notify } from './ui.manager.js';
import { html, setHtml } from './html.js';
import { t } from './i18n.js';
import { addToWordbook } from './wordbook.js';
import { chatValue, currentChatId } from './storage.js';
import { getSettings, getLang, getNativeLang, ai } from './runtime.js';
import { acceptObject, unionBy } from './ai/client.js';
import { readableText, plainText } from './plain-text.js';
import { dialogueLines, dialogueText } from './dialogue.js';
import { drawDialogue, stripDialogue, LINE_CLASS } from './ui/dialogue-layer.js';
import { showFuriganaFor, hideFuriganaFor, clearChatFurigana } from './furigana/messages.js';
import { setLayer, hasLayer, messagesWith, resetLayers, pruneDetachedDecor, untilRendered, cancelUntilRendered, DECOR_CLASS, } from './ui/message-decor.js';
let openPanel = () => { };
/** Registers openLearningPanel (called once by index.ts). */
export function setOpenPanelFn(fn) { openPanel = fn; }
// ════════════════════════════
// State
// ════════════════════════════
/** Results of messages currently highlighted in the DOM, by mesId. */
const annotations = new Map();
/** In-flight requests, by mesId. */
const requests = new Map();
const store = chatValue(KEY.annotations);
let suppressRestore = false; // true while the chat's annotations are being cleared
const mesSelector = (mesId) => `.mes[mesid="${CSS.escape(mesId)}"]`;
// ════════════════════════════
// Persistence
// ════════════════════════════
function persist(mesId, result) {
    store.set({ ...store.get(), [mesId]: result });
}
function unpersist(mesId) {
    const saved = store.get();
    if (!saved || !(mesId in saved))
        return;
    const { [mesId]: _removed, ...rest } = saved;
    store.set(rest);
}
// ════════════════════════════
// Highlighting
// ════════════════════════════
/** CSS class for a token: idiom / grammar, or the word's CEFR tier (a/b/c). */
function highlightClass(token) {
    if (token.type === 'idiom')
        return 'pg-hl-idiom';
    if (token.type === 'grammar')
        return 'pg-hl-grammar';
    const tier = levelClass(token.data.level);
    // Words without a usable level get the hardest tier
    return tier === 'grammar' || tier === 'sentence' ? 'pg-hl-c' : `pg-hl-${tier[0].toLowerCase()}`;
}
/** Tokens to look for, longest first so phrases win over the words inside them. */
function tokensOf(data) {
    return [
        ...(data.hard_words ?? []).map(w => ({ type: 'word', text: w.word, data: w })),
        ...(data.grammar_patterns ?? []).map(g => ({ type: 'grammar', text: g.pattern, data: g })),
        ...(data.idioms ?? []).map(i => ({ type: 'idiom', text: i.phrase, data: i })),
    ]
        .filter(tok => typeof tok.text === 'string' && tok.text.length > 0)
        .sort((a, b) => b.text.length - a.text.length);
}
/** Earliest whole-word occurrence of any token in `text` (longer tokens win ties: they come first). */
function firstMatch(text, tokens) {
    let best = null;
    for (const token of tokens) {
        const index = findWord(text, token.text);
        if (index !== -1 && (!best || index < best.index))
            best = { index, token };
    }
    return best;
}
function highlightSpan(token) {
    const span = document.createElement('span');
    span.className = `pg-clickable-word ${DECOR_CLASS} ${highlightClass(token)}`;
    span.textContent = token.text;
    span.addEventListener('click', () => openPanel('learn', token));
    return span;
}
/** Wraps every token occurrence in one text node. */
function highlightTextNode(node, tokens) {
    let rest = node.textContent ?? '';
    if (!rest.trim())
        return;
    const frag = document.createDocumentFragment();
    let matched = false;
    for (let m = firstMatch(rest, tokens); m; m = firstMatch(rest, tokens)) {
        if (m.index > 0)
            frag.append(rest.slice(0, m.index));
        frag.append(highlightSpan(m.token));
        rest = rest.slice(m.index + m.token.text.length);
        matched = true;
    }
    if (!matched)
        return;
    if (rest)
        frag.append(rest);
    node.replaceWith(frag);
}
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'RUBY']);
function textNodesIn(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: n => n instanceof Element && (SKIP_TAGS.has(n.tagName) || n.classList.contains('pg-clickable-word'))
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode())
        if (n instanceof Text)
            nodes.push(n);
    return nodes;
}
function highlight(textEl, data) {
    const tokens = tokensOf(data);
    // Dialogue-only analyses highlight inside the dialogue lines only
    const nodes = textNodesIn(textEl).filter(n => !data.dialogue || n.parentElement?.closest(`.${LINE_CLASS}`));
    nodes.forEach(node => highlightTextNode(node, tokens));
}
/** Replaces highlight spans with plain text. */
export function stripHighlightsFromEl(textEl) {
    textEl.querySelectorAll('.pg-clickable-word').forEach(span => span.replaceWith(span.textContent ?? ''));
    textEl.normalize();
}
// ════════════════════════════
// Show / hide on a message
// ════════════════════════════
function annotateButton(msgEl) {
    return msgEl.querySelector('.pg-annotate-btn');
}
function show(msgEl, mesId, data) {
    if (!msgEl.querySelector('.mes_text'))
        return;
    annotations.set(mesId, data);
    setLayer(mesId, 'dialogue', data.dialogue ? { draw: drawDialogue, strip: stripDialogue } : null);
    setLayer(mesId, 'annotation', { draw: textEl => highlight(textEl, data), strip: stripHighlightsFromEl });
    annotateButton(msgEl)?.classList.add('pg-btn-active');
}
export function removeAnnotation(msgEl, mesId) {
    hideFuriganaFor(mesId);
    setLayer(mesId, 'annotation', null);
    setLayer(mesId, 'dialogue', null);
    annotations.delete(mesId);
    annotateButton(msgEl)?.classList.remove('pg-btn-active');
    unpersist(mesId);
}
// ════════════════════════════
// Restore after load / chat switch
// ════════════════════════════
/** Forgets messages that left the DOM (deleted), so their observers can be collected. */
function pruneDetached() {
    pruneDetachedDecor();
    for (const mesId of annotations.keys())
        if (!hasLayer(mesId, 'annotation'))
            annotations.delete(mesId);
}
/** Re-applies saved annotations to messages that are in the DOM and not yet highlighted. */
export function restoreAnnotations() {
    pruneDetached();
    if (suppressRestore || !getSettings().enabled_annotator)
        return;
    for (const [mesId, data] of Object.entries(store.get() ?? {})) {
        if (annotations.has(mesId))
            continue;
        const msgEl = document.querySelector(mesSelector(mesId));
        if (msgEl?.querySelector('.mes_text'))
            show(msgEl, mesId, data);
    }
}
/** ST renders messages asynchronously after a load — keep restoring until they all exist (or time runs out). */
export function restoreWithRetry() {
    untilRendered('annotation', Object.keys(store.get() ?? {}), restoreAnnotations);
}
// ════════════════════════════
// Clearing
// ════════════════════════════
/** Cancels requests and forgets the DOM state of the previous chat (saved data is untouched). */
export function resetChatState() {
    cancelUntilRendered('annotation');
    requests.forEach(r => r.abort());
    requests.clear();
    resetLayers('annotation');
    resetLayers('dialogue');
    annotations.clear();
}
/** A swiped message gets new text: drop its annotation and any pending request. */
export function forgetMessage(mesId) {
    requests.get(mesId)?.abort();
    requests.delete(mesId);
    const msgEl = document.querySelector(mesSelector(mesId));
    if (msgEl) {
        removeAnnotation(msgEl, mesId);
        annotateButton(msgEl)?.classList.remove('pg-btn-busy');
    }
    else {
        setLayer(mesId, 'annotation', null);
        setLayer(mesId, 'dialogue', null);
        annotations.delete(mesId);
        unpersist(mesId);
    }
}
/** Deletes every saved annotation of the open chat and removes the highlights. */
export function clearCurrentChatAnnotations() {
    suppressRestore = true;
    messagesWith('annotation').forEach(mesId => setLayer(mesId, 'annotation', null));
    messagesWith('dialogue').forEach(mesId => setLayer(mesId, 'dialogue', null));
    resetChatState();
    store.delete();
    clearChatFurigana();
    document.querySelectorAll('.pg-annotate-btn').forEach(b => b.classList.remove('pg-btn-active'));
    setTimeout(() => { suppressRestore = false; }, 0);
}
// ════════════════════════════
// Snackbar
// ════════════════════════════
function showSnackbar(onStop) {
    hideSnackbar();
    const el = Object.assign(document.createElement('div'), { id: 'pg-snackbar', className: 'pg-snackbar' });
    setHtml(el, html `
        <span class="pg-snackbar-text"><i class="fa-solid fa-spinner fa-spin"></i>&nbsp; ${t('ann.analysing')}</span>
        <button class="pg-snackbar-stop">${t('ann.stop')}</button>`);
    el.querySelector('.pg-snackbar-stop')?.addEventListener('click', () => { onStop(); hideSnackbar(); });
    document.body.appendChild(el);
    void el.offsetWidth; // reflow so the entry transition runs on mobile
    el.classList.add('pg-snackbar-visible');
}
function hideSnackbar() {
    const el = document.getElementById('pg-snackbar');
    if (!el)
        return;
    el.classList.remove('pg-snackbar-visible');
    setTimeout(() => el.remove(), DELAY.snackbarFadeOut);
}
// ════════════════════════════
// Run
// ════════════════════════════
function messageButton(className, title, onClick) {
    const btn = Object.assign(document.createElement('div'), {
        className: `mes_button ${className} interactable`, title, tabIndex: 0,
    });
    btn.addEventListener('click', onClick);
    return btn;
}
/** Adds the 📖 annotate and 🌍 panel buttons to every AI message that lacks them. */
export function injectAnnotateButtons() {
    if (!getSettings().enabled_annotator)
        return;
    document.querySelectorAll('.mes[is_user="false"]').forEach(msgEl => {
        const mesId = msgEl.getAttribute('mesid');
        const extras = msgEl.querySelector('.extraMesButtons');
        if (!mesId || !extras || msgEl.querySelector('.pg-annotate-btn'))
            return;
        extras.prepend(messageButton('pg-annotate-btn fa-solid fa-book-open', 'Polyglot: annotate for study', () => runAnnotator(msgEl, mesId)), messageButton('pg-open-btn fa-solid fa-earth-europe', 'Open Polyglot panel', () => openPanel('learn', null)));
    });
}
/** Saves found idioms to the wordbook and this chat (when enabled). Returns how many were new. */
function saveIdioms(idioms = []) {
    if (getSettings().auto_save_idioms === false)
        return 0;
    return idioms
        .filter(i => i.phrase?.trim() && i.meaning?.trim())
        .map(i => addToWordbook({
        word: i.phrase, base_form: i.base_form?.trim() || i.phrase.trim(), meaning: i.meaning,
        meaning_lang: getNativeLang(), level: 'idiom', context_meaning: i.context_meaning,
    }, { quiet: true }))
        .filter(r => r === 'added').length;
}
/** Annotates a message — or removes its annotation if it already has one. */
/** Two cut-off analyses as one: every highlight either attempt found, without repeats. */
function mergeAnnotations(preferred, other) {
    const list = (a, b, keyOf) => unionBy(keyOf)(a ?? [], b ?? []);
    return {
        hard_words: list(preferred.hard_words, other.hard_words, w => w.word),
        grammar_patterns: list(preferred.grammar_patterns, other.grammar_patterns, g => g.pattern),
        idioms: list(preferred.idioms, other.idioms, i => i.phrase),
    };
}
export async function runAnnotator(msgEl, mesId) {
    if (!getSettings().enabled_annotator || requests.has(mesId))
        return;
    if (annotations.has(mesId)) {
        removeAnnotation(msgEl, mesId);
        return;
    }
    const textEl = msgEl.querySelector('.mes_text');
    if (!textEl)
        return;
    // "Dialogue only": the quoted lines are what gets studied
    const dialogue = !!getSettings().dialogue_only;
    const plain = plainText(textEl);
    const lines = dialogue ? dialogueLines(plain) : undefined;
    if (lines && !lines.length) {
        notify(t('dlg.none'), 'info', 3000);
        return;
    }
    const studied = lines ? dialogueText(plain, lines) : readableText(textEl);
    const chatId = currentChatId();
    const btn = annotateButton(msgEl);
    const abort = new AbortController();
    requests.set(mesId, abort);
    btn?.classList.add('pg-btn-busy');
    showSnackbar(() => { abort.abort(); hideFuriganaFor(mesId); });
    // Readings run alongside: the wait is the longer request, not both
    const readings = showFuriganaFor(mesId, lines);
    try {
        const { data } = await ai.json({
            prompt: annotatorPrompt(studied, getLang(), getSettings().cefr_level, getNativeLang()),
            signal: abort.signal,
            accept: (acceptObject),
            merge: mergeAnnotations,
        });
        if (abort.signal.aborted || chatId !== currentChatId())
            return;
        const result = dialogue ? { ...data, dialogue: true } : data;
        show(msgEl, mesId, result);
        persist(mesId, result);
        const added = saveIdioms(data.idioms);
        if (added)
            notify(t('ann.idiomsAdded', { n: added }), 'info', 2500);
        await readings;
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        console.error('[Polyglot] Annotation error:', e);
        notify(t('ann.error', { msg: e instanceof Error ? e.message : String(e) }), 'err', 3000);
    }
    finally {
        btn?.classList.remove('pg-btn-busy');
        if (requests.get(mesId) === abort)
            requests.delete(mesId);
        hideSnackbar();
    }
}
