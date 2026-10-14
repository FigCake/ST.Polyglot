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
//   • Message text is read through plain-text.ts (no furigana readings), and
//     what study-scope.ts skips (status windows, names) is neither sent nor highlighted.
import { KEY } from './constants.js';
import { ST_SEL, mesSelector, mesIdOf, mesTextOf } from './st-dom.js';
import { levelClass, findWord, entryList, withEntryFor, relocateEntries } from './utils.js';
import { annotatorPrompt } from './prompts.js';
import { notify } from './ui.manager.js';
import { t } from './i18n.js';
import { addToWordbook } from './wordbook.js';
import { chatValue, currentChatId } from './storage.js';
import { getSettings, getLang, getNativeLang, ai, getContext } from './runtime.js';
import { isRecord, unionBy, withEmptyFields } from './ai/client.js';
import { plainText, shownTextHashes } from './plain-text.js';
import { studiedText, skippedNodes, skippedNames, wordSkipper } from './study-scope.js';
import { drawDialogue, stripDialogue, LINE_CLASS } from './ui/dialogue-layer.js';
import { showFuriganaFor, hideFuriganaFor, clearChatFurigana } from './furigana/messages.js';
import { textHash } from './furigana/model.js';
import { showStopBar, hideStopBar } from './stop-bar.js';
import { knownWordsIn, isKnownWord, recordSeenForms } from './saved-marks.js';
import { setLayer, hasLayer, messagesWith, resetLayers, pruneDetachedDecor, untilRendered, cancelUntilRendered, DECOR_CLASS, } from './ui/message-decor.js';
let openPanel = () => { };
/** Registers openLearningPanel (called once by index.ts). */
export function setOpenPanelFn(fn) { openPanel = fn; }
// ── State ─────────────────────────────────────────────────────────────────────
/** Results of messages currently highlighted in the DOM, by mesId. */
const annotations = new Map();
/** In-flight requests, by mesId. */
const requests = new Map();
/**
 * Saved analyses by message index: one per text the message has shown (its
 * swipes, edits), so swiping back brings an analysis back. Older saves hold a
 * single analysis instead of a list.
 */
const store = chatValue(KEY.annotations);
const KEEP_PER_MESSAGE = 6;
let suppressRestore = false; // true while the chat's annotations are being cleared
// ── Persistence ───────────────────────────────────────────────────────────────
const savedList = (mesId) => entryList(store.get()?.[mesId]);
/** The saved analysis for the text the message shows now (an older save without a hash counts as current). */
function savedFor(mesId, textEl) {
    const list = savedList(mesId);
    const h = textHash(plainText(textEl));
    return list.find(e => e.h === h) ?? list.find(e => !e.h);
}
function persist(mesId, result) {
    store.set({ ...store.get(), [mesId]: withEntryFor(savedList(mesId), result, KEEP_PER_MESSAGE) });
}
/** Deletes the saved analysis of one text of the message (the one `result` was made for). */
function unpersist(mesId, result) {
    const saved = store.get();
    if (!saved || !(mesId in saved))
        return;
    const { [mesId]: list, ...rest } = saved;
    const kept = entryList(list).filter(e => e.h !== result.h);
    store.set(kept.length ? { ...rest, [mesId]: kept } : rest);
}
// ── Highlighting ──────────────────────────────────────────────────────────────
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
/** Tokens to look for, longest first so phrases win over the words inside them. Names are not words to study. */
function tokensOf(data) {
    const skip = wordSkipper();
    return [
        // Known words are left out (the request asked for that too; a reply may still list one)
        ...(data.hard_words ?? []).filter(w => !skip(w.word, w.base_form) && !isKnownWord(w.word, w.base_form))
            .map(w => ({ type: 'word', text: w.word, data: w })),
        ...(data.grammar_patterns ?? []).map(g => ({ type: 'grammar', text: g.pattern, data: g })),
        ...(data.idioms ?? []).filter(i => !skip(i.phrase, i.base_form)).map(i => ({ type: 'idiom', text: i.phrase, data: i })),
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
    const skipped = skippedNodes(textEl);
    // Dialogue-only analyses highlight inside the dialogue lines only
    const nodes = textNodesIn(textEl)
        .filter(n => !skipped.has(n) && (!data.dialogue || n.parentElement?.closest(`.${LINE_CLASS}`)));
    nodes.forEach(node => highlightTextNode(node, tokens));
}
/** Replaces highlight spans with plain text. */
function stripHighlightsFromEl(textEl) {
    textEl.querySelectorAll('.pg-clickable-word').forEach(span => span.replaceWith(span.textContent ?? ''));
    textEl.normalize();
}
// ── Show / hide on a message ──────────────────────────────────────────────────
function annotateButton(msgEl) {
    return msgEl.querySelector('.pg-annotate-btn');
}
function show(msgEl, mesId, data) {
    if (!msgEl.querySelector(ST_SEL.mesText))
        return;
    annotations.set(mesId, data);
    setLayer(mesId, 'dialogue', data.dialogue ? { draw: drawDialogue, strip: stripDialogue } : null);
    setLayer(mesId, 'annotation', { draw: textEl => highlight(textEl, data), strip: stripHighlightsFromEl });
    annotateButton(msgEl)?.classList.add('pg-btn-active');
}
/** The user removes the message's analysis (📖 again): taken down and deleted, for this text only. */
function removeAnnotation(msgEl, mesId) {
    const data = annotations.get(mesId);
    hideFuriganaFor(mesId);
    takeDown(mesId);
    annotateButton(msgEl)?.classList.remove('pg-btn-active');
    if (data)
        unpersist(mesId, data);
}
/** Removes the message's highlights from the page (what is saved stays). */
function takeDown(mesId) {
    setLayer(mesId, 'annotation', null);
    setLayer(mesId, 'dialogue', null);
    annotations.delete(mesId);
}
/** The 📖 buttons show exactly which messages are highlighted now. */
function syncButtons() {
    document.querySelectorAll('.pg-annotate-btn').forEach(btn => {
        const mesId = mesIdOf(btn);
        btn.classList.toggle('pg-btn-active', !!mesId && annotations.has(mesId));
    });
}
// ── Restore after load / chat switch ──────────────────────────────────────────
/** Forgets messages that left the DOM (deleted), so their observers can be collected. */
function pruneDetached() {
    pruneDetachedDecor();
    for (const mesId of annotations.keys())
        if (!hasLayer(mesId, 'annotation'))
            annotations.delete(mesId);
}
/**
 * Whether an analysis belongs to the text the message shows now. ST reuses an
 * index for another swipe, a regenerated reply or after a deletion, and an edit
 * changes the text; older saves without a hash cannot be checked and count as current.
 */
const stillFits = (data, textEl) => !data.h || data.h === textHash(plainText(textEl));
/** Shows, on every message in the DOM, the saved analysis of the text it shows now (and only that). */
export function restoreAnnotations() {
    pruneDetached();
    if (suppressRestore || !getSettings().enabled_annotator) {
        syncButtons();
        return;
    }
    // A message whose text changed under its highlights (swiped, regenerated, edited) loses them
    for (const [mesId, data] of annotations) {
        const textEl = mesTextOf(mesId);
        if (textEl && !stillFits(data, textEl))
            forgetMessage(mesId);
    }
    for (const mesId of Object.keys(store.get() ?? {})) {
        if (annotations.has(mesId))
            continue;
        const msgEl = document.querySelector(mesSelector(mesId));
        const textEl = msgEl?.querySelector(ST_SEL.mesText);
        const data = textEl && savedFor(mesId, textEl);
        if (msgEl && data)
            show(msgEl, mesId, data);
    }
    syncButtons();
}
/** Messages were deleted and ST renumbered the rest: saved analyses follow their messages. */
export function relocateAnnotations() {
    const saved = store.get();
    const length = getContext().chat?.length;
    const moved = saved && typeof length === 'number' && relocateEntries(saved, shownTextHashes(), length);
    if (moved)
        store.set(moved);
}
/** ST renders messages asynchronously after a load — keep restoring until they all exist (or time runs out). */
export function restoreWithRetry() {
    untilRendered('annotation', Object.keys(store.get() ?? {}), restoreAnnotations);
}
// ── Clearing ──────────────────────────────────────────────────────────────────
/** Cancels requests and forgets the DOM state of the previous chat (saved data is untouched). */
export function resetChatState() {
    cancelUntilRendered('annotation');
    requests.forEach(r => r.abort());
    requests.clear();
    resetLayers('annotation');
    resetLayers('dialogue');
    annotations.clear();
}
/**
 * The message shows other text (a swipe, an edit, a regenerated reply): its
 * highlights and pending request go; analyses saved for its texts stay, so
 * swiping back shows that swipe's analysis again (restoreAnnotations).
 */
export function forgetMessage(mesId) {
    requests.get(mesId)?.abort();
    requests.delete(mesId);
    takeDown(mesId);
    // An older save without a hash cannot be matched to a text: it went with the text that changed
    const list = savedList(mesId);
    if (list.some(e => !e.h)) {
        const { [mesId]: _old, ...rest } = store.get() ?? {};
        const kept = list.filter(e => e.h);
        store.set(kept.length ? { ...rest, [mesId]: kept } : rest);
    }
    const btn = document.querySelector(mesSelector(mesId))?.querySelector('.pg-annotate-btn');
    btn?.classList.remove('pg-btn-active', 'pg-btn-busy');
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
// ── Run ───────────────────────────────────────────────────────────────────────
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
    document.querySelectorAll(ST_SEL.aiMes).forEach(msgEl => {
        const mesId = mesIdOf(msgEl);
        const extras = msgEl.querySelector(ST_SEL.extraMesButtons);
        if (!mesId || !extras || msgEl.querySelector('.pg-annotate-btn'))
            return;
        extras.prepend(
        // The id is read on click: ST renumbers messages when one before them is deleted
        messageButton('pg-annotate-btn fa-solid fa-book-open', 'Polyglot: annotate for study', () => {
            const id = mesIdOf(msgEl);
            if (id)
                void runAnnotator(msgEl, id);
        }), messageButton('pg-open-btn fa-solid fa-earth-europe', 'Open Polyglot panel', () => openPanel('learn', null)));
    });
}
/** Saves found idioms to the wordbook and this chat (when enabled). Returns how many were new. */
function saveIdioms(idioms = []) {
    if (getSettings().auto_save_idioms === false)
        return 0;
    const skip = wordSkipper();
    return idioms
        .filter(i => i.phrase?.trim() && i.meaning?.trim() && !skip(i.phrase, i.base_form))
        .map(i => addToWordbook({
        word: i.phrase, base_form: i.base_form?.trim() || i.phrase.trim(), meaning: i.meaning,
        meaning_lang: getNativeLang(), level: 'idiom', context_meaning: i.context_meaning,
    }, { quiet: true }))
        .filter(r => r === 'added').length;
}
/** Two cut-off analyses as one: every highlight either attempt found, without repeats. */
/** The text fields annotatorPrompt asks for in each list's items; the first is the item's own text. */
const ITEM_FIELDS = {
    hard_words: ['word', 'base_form', 'pos_info', 'meaning', 'context_meaning', 'level'],
    grammar_patterns: ['pattern', 'meaning', 'structure', 'words_used'],
    idioms: ['phrase', 'base_form', 'meaning', 'context_meaning'],
};
/**
 * The analysis as far as it can be shown: an item without its own text is
 * dropped, other fields it lacks are left empty. Gaps are not asked for again
 * (one would repeat the whole analysis); a reply with none of the lists is the
 * wrong shape and is.
 */
export function acceptAnnotation(v) {
    if (!isRecord(v) || !Object.keys(ITEM_FIELDS).some(k => Array.isArray(v[k])))
        return null;
    const items = (list, fields) => (Array.isArray(list) ? list : [])
        .filter(x => isRecord(x) && typeof x[fields[0]] === 'string' && x[fields[0]].trim())
        .map(x => withEmptyFields(x, fields));
    return {
        hard_words: items(v.hard_words, ITEM_FIELDS.hard_words),
        grammar_patterns: items(v.grammar_patterns, ITEM_FIELDS.grammar_patterns),
        idioms: items(v.idioms, ITEM_FIELDS.idioms),
    };
}
function mergeAnnotations(preferred, other) {
    const list = (a, b, keyOf) => unionBy(keyOf)(a ?? [], b ?? []);
    return {
        hard_words: list(preferred.hard_words, other.hard_words, w => w.word),
        grammar_patterns: list(preferred.grammar_patterns, other.grammar_patterns, g => g.pattern),
        idioms: list(preferred.idioms, other.idioms, i => i.phrase),
    };
}
/** Draws the shown analyses again, e.g. after the names or parts to skip changed. */
export function redrawAnnotations() {
    for (const [mesId, data] of annotations) {
        const msgEl = document.querySelector(mesSelector(mesId));
        if (msgEl)
            show(msgEl, mesId, data);
    }
}
/** Whether the message is annotated now. */
export const isAnnotated = (mesId) => annotations.has(mesId);
/** Annotates a message — or removes its annotation if it already has one. */
export async function runAnnotator(msgEl, mesId) {
    if (!getSettings().enabled_annotator || requests.has(mesId))
        return;
    if (annotations.has(mesId)) {
        removeAnnotation(msgEl, mesId);
        return;
    }
    const textEl = msgEl.querySelector(ST_SEL.mesText);
    if (!textEl)
        return;
    // "Dialogue only": the quoted lines are what gets studied
    const dialogue = !!getSettings().dialogue_only;
    const { text: studied, plain, lines } = studiedText(textEl, dialogue);
    if (lines && !lines.length) {
        notify(t('dlg.none'), 'info', 3000);
        return;
    }
    if (!studied.trim()) {
        notify(t('ann.allSkipped'), 'info', 3000);
        return;
    }
    const chatId = currentChatId();
    const hash = textHash(plain);
    const btn = annotateButton(msgEl);
    const abort = new AbortController();
    requests.set(mesId, abort);
    btn?.classList.add('pg-btn-busy');
    showStopBar(abort, () => { abort.abort(); hideFuriganaFor(mesId); });
    // Readings run alongside: the wait is the longer request, not both
    const readings = showFuriganaFor(mesId, lines);
    try {
        const { data } = await ai.json({
            prompt: annotatorPrompt(studied, getLang(), getSettings().cefr_level, getNativeLang(), skippedNames(), knownWordsIn(studied)),
            signal: abort.signal,
            accept: acceptAnnotation,
            merge: mergeAnnotations,
        });
        if (abort.signal.aborted || chatId !== currentChatId())
            return;
        // The message may have been regenerated or edited while the reply was on its way
        const textNow = mesTextOf(mesId);
        const msgNow = textNow?.closest(ST_SEL.mes);
        if (!textNow || !msgNow || textHash(plainText(textNow)) !== hash)
            return;
        const result = { ...data, h: hash, ...(dialogue && { dialogue: true }) };
        show(msgNow, mesId, result);
        persist(mesId, result);
        // The forms saved words were met in: found without the AI from now on
        recordSeenForms(data.hard_words ?? []);
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
        hideStopBar(abort);
    }
}
