// Sentence translation: an inline bubble under the paragraph of a sentence in
// an AI message. How it is asked for depends on the input used, not the device:
//
//   mouse   double-click a sentence → translate · drag-select → [Look up]
//   touch   select text (the OS long-press) → [Look up] [Translate sentence]
//
// Touch has no gesture of its own: a long-press is the browser's text
// selection, and competing with it opened three menus at once.
//
//   ui/tap/sentence.ts       locating the sentence under the pointer
//   ui/tap/bubble.ts         the bubble and its actions
//   ui/tap/deep-analysis.ts  the "Deep" breakdown inside a bubble
//   ui/tap/lookup.ts         select text → "Look up" tooltip (re-exported here)
import { tapTranslatePrompt } from '../prompts.js';
import { ai, getLang, getNativeLang } from '../runtime.js';
import { isRecord } from '../ai/client.js';
import { messageTextOf, sentenceAround } from './tap/sentence.js';
import { ST_SEL, mesSelector, mesIdOf } from '../st-dom.js';
import { plainText, plainOffsetIn } from '../plain-text.js';
import { showBubble, closeBubble } from './tap/bubble.js';
import { removeSelectionTooltip, setupTextSelectionTooltip } from './tap/lookup.js';
import { LINE_CLASS } from './dialogue-layer.js';
import { dialogueLines } from '../dialogue.js';
const MIN_SENTENCE = 3;
/** A double-click this soon after a touch came from a double-tap, not a mouse. */
const TOUCH_GRACE_MS = 800;
/** In-flight translations, by mesId. */
const requests = new Map();
/** Text position under a screen point, if it lies in an AI message (not on a highlight, nor in a translation bubble). */
function caretAt(x, y) {
    let node = null, offset = 0;
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        if (range) {
            node = range.startContainer;
            offset = range.startOffset;
        }
    }
    else if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (pos) {
            node = pos.offsetNode;
            offset = pos.offset;
        }
    }
    const el = node instanceof Element ? node : node?.parentElement;
    const message = el?.closest(ST_SEL.aiMes);
    // A double-click in a bubble selects its text; it is not a tap on the message
    if (!node || !message || el?.closest('.pg-clickable-word, .pg-tap-bubble'))
        return null;
    return { node, offset, mesId: mesIdOf(message) ?? '' };
}
/** The sentence at the caret plus where its bubble goes (after the paragraph it is in). */
function targetAt({ node, offset }) {
    const textEl = messageTextOf(node);
    if (!textEl)
        return null;
    const full = plainText(textEl);
    const at = plainOffsetIn(textEl, node, offset);
    // In a message studied as dialogue, a line is translated whole
    const line = textEl.querySelector(`.${LINE_CLASS}`)
        ? dialogueLines(full).find(l => at >= l.start && at < l.end)
        : undefined;
    const sentence = line ? full.slice(line.start, line.end).trim() : sentenceAround(full, Math.max(0, at));
    if (sentence.length < MIN_SENTENCE)
        return null;
    let anchor = node;
    while (anchor && anchor.parentNode !== textEl)
        anchor = anchor.parentNode;
    return { textEl, anchorEl: anchor instanceof HTMLElement ? anchor : null, sentence };
}
// ── Translate ─────────────────────────────────────────────────────────────────
const acceptTranslation = (v) => isRecord(v) && typeof v.translation === 'string'
    ? { ...v, key_verbs: Array.isArray(v.key_verbs) ? v.key_verbs : [] }
    : null;
/** Translations already made this session, by language + sentence: asking again costs nothing. */
const translated = new Map();
const MAX_CACHED = 300;
/** Shows the translation bubble for a sentence (from the cache, or asking the model). */
async function translateTarget(target, mesId) {
    const key = `${getLang()}\u0000${getNativeLang()}\u0000${target.sentence}`;
    requests.get(mesId)?.abort();
    if (!showBubble(target, { kind: 'loading' }))
        return; // same sentence tapped again → closed
    const cached = translated.get(key);
    if (cached) {
        showBubble(target, { kind: 'result', result: cached });
        return;
    }
    const request = new AbortController();
    requests.set(mesId, request);
    try {
        const { data } = await ai.json({
            prompt: tapTranslatePrompt(target.sentence, getLang(), getNativeLang()),
            signal: request.signal,
            accept: acceptTranslation,
        });
        if (translated.size >= MAX_CACHED)
            translated.delete(translated.keys().next().value);
        translated.set(key, data);
        if (!request.signal.aborted)
            showBubble(target, { kind: 'result', result: data });
    }
    catch (e) {
        if (!request.signal.aborted)
            showBubble(target, { kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    finally {
        if (requests.get(mesId) === request)
            requests.delete(mesId);
    }
}
async function translateAt(caret) {
    const target = targetAt(caret);
    if (target)
        await translateTarget(target, caret.mesId);
}
// ── Gestures ──────────────────────────────────────────────────────────────────
const inChat = (target) => !!document.querySelector(ST_SEL.chat)?.contains(target);
let lastTouch = -Infinity;
function onDoubleClick(e) {
    if (performance.now() - lastTouch < TOUCH_GRACE_MS || !inChat(e.target))
        return;
    const caret = caretAt(e.clientX, e.clientY);
    if (!caret)
        return;
    getSelection()?.removeAllRanges(); // the double-click selected a word
    removeSelectionTooltip();
    translateAt(caret);
}
/** Clicking anywhere outside a bubble closes bubbles — except inside the panel or a conjugation popup. */
function onOutsideClick(e) {
    const target = e.target;
    if (target.closest('.pg-tap-bubble, #pg-box-pg-learning-panel, .pg-conj-overlay'))
        return;
    removeTapBubbles();
}
/** Translates the sentence at the start of a selection (the touch [Translate] button). */
function translateSelection(range) {
    const message = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)
        ?.closest(ST_SEL.aiMes);
    if (!message)
        return;
    void translateAt({ node: range.startContainer, offset: range.startOffset, mesId: mesIdOf(message) ?? '' });
}
export function setupTapToTranslate() {
    document.addEventListener('touchstart', () => { lastTouch = performance.now(); }, { passive: true, capture: true });
    document.addEventListener('dblclick', onDoubleClick);
    document.addEventListener('click', onOutsideClick);
    const inBubble = (n) => !!(n instanceof Element ? n : n.parentElement)?.closest('.pg-tap-bubble');
    setupTextSelectionTooltip({
        translate: translateSelection,
        canTranslate: range => !inBubble(range.startContainer) && !!messageTextOf(range.startContainer)?.closest(ST_SEL.aiMes),
    });
}
// ── Cleanup ───────────────────────────────────────────────────────────────────
/** Closes translation bubbles — in one message, or everywhere. */
export function removeTapBubbles(mesId = null) {
    const scope = mesId ? `${mesSelector(mesId)} ` : '';
    document.querySelectorAll(`${scope}.pg-tap-bubble`).forEach(closeBubble);
}
/** Cancels all in-flight translations (on chat switch). */
export function abortAllTapTranslate() {
    requests.forEach(r => r.abort());
    requests.clear();
}
