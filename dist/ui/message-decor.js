// ════════════════════════════
// Polyglot  ui/message-decor.ts
// ════════════════════════════
// What Polyglot draws over a chat message's text, as ordered layers:
//
//   1. dialogue     marks on lines of dialogue + their translate buttons ("dialogue only")
//   2. annotation   highlight spans around hard words, grammar and idioms
//   3. furigana     <ruby> readings over kanji (inside highlights too)
//
// A layer only ever wraps text nodes, so the text stays the same. Layers are
// always drawn in this order on clean text — a change to one layer strips
// and redraws them all — so highlights never have to match across a ruby.
//
// ST replaces a message's HTML on streaming, edits and re-renders; one
// observer per decorated message redraws the layers when that happens.
//
// Dependencies: constants.ts
import { DELAY } from '../constants.js';
const ORDER = ['dialogue', 'annotation', 'furigana'];
/** Marks every element a layer inserts, so a re-rendered (clean) message can be recognised. */
export const DECOR_CLASS = 'pg-decor';
/** ST may replace a message's HTML repeatedly; past this many redraws something is looping. */
const MAX_REDRAWS = 20;
const messages = new Map();
const OBSERVE = { childList: true, subtree: true };
const mesSelector = (mesId) => `.mes[mesid="${CSS.escape(mesId)}"]`;
const textOf = (mesId) => document.querySelector(`${mesSelector(mesId)} .mes_text`);
/**
 * Runs a DOM change on a message without its observer reacting to it. The
 * observer resumes on the next frame; a re-render that happened in between
 * (while it was not listening) is caught by comparing the text's first node.
 */
function quietly(mesId, entry, textEl, change) {
    entry.observer.disconnect();
    if (entry.frame !== null)
        cancelAnimationFrame(entry.frame);
    change();
    entry.drawn = textEl.firstChild;
    entry.frame = requestAnimationFrame(() => {
        entry.frame = null;
        if (messages.get(mesId) !== entry)
            return;
        entry.observer.observe(textEl, OBSERVE);
        if (textEl.firstChild !== entry.drawn)
            onMutation(mesId, entry, textEl);
    });
}
function drawAll(entry, textEl) {
    for (const layer of ORDER)
        entry.layers[layer]?.draw(textEl);
}
function track(mesId, textEl) {
    const existing = messages.get(mesId);
    if (existing)
        return existing;
    const entry = {
        layers: {}, observer: new MutationObserver(() => onMutation(mesId, entry, textEl)), frame: null, redraws: 0, drawn: null,
    };
    messages.set(mesId, entry);
    entry.observer.observe(textEl, OBSERVE);
    return entry;
}
/** ST re-rendered the text (our marks are gone): draw the layers again. */
function onMutation(mesId, entry, textEl) {
    if (textEl.querySelector(`.${DECOR_CLASS}, .pg-tap-bubble`))
        return;
    if (++entry.redraws > MAX_REDRAWS) {
        untrack(mesId);
        console.warn('[Polyglot] message decorations: redraw limit reached for message', mesId);
        return;
    }
    quietly(mesId, entry, textEl, () => drawAll(entry, textEl));
}
function untrack(mesId) {
    const entry = messages.get(mesId);
    if (!entry)
        return;
    entry.observer.disconnect();
    if (entry.frame !== null)
        cancelAnimationFrame(entry.frame);
    messages.delete(mesId);
}
// ── Public API ────────────────────────────────────────────────────────────────
/** Sets (or, with null, removes) one layer of a message and redraws its layers. */
export function setLayer(mesId, layer, decoration) {
    const textEl = textOf(mesId);
    if (!textEl) {
        if (!decoration)
            clearLayer(mesId, layer);
        return;
    }
    const entry = track(mesId, textEl);
    const before = entry.layers[layer];
    quietly(mesId, entry, textEl, () => {
        // Strip top-down (furigana before the highlights it sits in), then draw bottom-up
        for (const l of [...ORDER].reverse())
            (l === layer ? before : entry.layers[l])?.strip(textEl);
        if (decoration)
            entry.layers[layer] = decoration;
        else
            delete entry.layers[layer];
        drawAll(entry, textEl);
    });
    if (!Object.keys(entry.layers).length)
        untrack(mesId);
}
/** Forgets a layer without touching the DOM (the message is gone or about to change). */
function clearLayer(mesId, layer) {
    const entry = messages.get(mesId);
    if (!entry)
        return;
    delete entry.layers[layer];
    if (!Object.keys(entry.layers).length)
        untrack(mesId);
}
export const hasLayer = (mesId, layer) => !!messages.get(mesId)?.layers[layer];
/** Message ids that currently show `layer`. */
export const messagesWith = (layer) => [...messages.entries()].filter(([, e]) => e.layers[layer]).map(([id]) => id);
/** Forgets one layer of every message, or everything, without touching the DOM (chat switch). */
export function resetLayers(layer) {
    for (const mesId of [...messages.keys()]) {
        if (layer)
            clearLayer(mesId, layer);
        else
            untrack(mesId);
    }
}
/** Stops tracking messages that left the DOM (deleted), so their observers can be collected. */
export function pruneDetachedDecor() {
    for (const mesId of [...messages.keys()])
        if (!textOf(mesId))
            untrack(mesId);
}
// ── Restoring after a chat loads ──────────────────────────────────────────────
const waits = new Map();
/**
 * ST renders a loaded chat's messages asynchronously: runs `restore` now and
 * again whenever more of `mesIds` appear, until all exist or time runs out.
 * A new call with the same `key` replaces the previous wait.
 */
export function untilRendered(key, mesIds, restore) {
    const pending = new Set(mesIds);
    if (!pending.size)
        return;
    const generation = (waits.get(key) ?? 0) + 1;
    waits.set(key, generation);
    const deadline = performance.now() + DELAY.restoreDeadline;
    const attempt = () => {
        if (waits.get(key) !== generation)
            return;
        let appeared = false;
        for (const mesId of pending)
            if (textOf(mesId)) {
                pending.delete(mesId);
                appeared = true;
            }
        if (appeared)
            restore();
        if (pending.size && performance.now() < deadline)
            setTimeout(attempt, DELAY.animFrame);
    };
    setTimeout(attempt, DELAY.animFrame);
}
/** Cancels a pending untilRendered() wait. */
export function cancelUntilRendered(key) {
    waits.set(key, (waits.get(key) ?? 0) + 1);
}
