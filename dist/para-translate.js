// Paragraph translation: the whole message translated, each paragraph's
// translation drawn right under it. The original is untouched, so 📖, look-up,
// tap translation and furigana keep working on it: the translations are left
// out of the message's text everywhere (plain-text.ts) and never highlighted.
//
// Lifecycle of one message:
//   🌐 click (or a new message with "auto") → one request for all paragraphs (no retry)
//        → 'translation' layer (ui/message-decor.ts) → saved in chat metadata, per text
//   🌐 again → hidden (kept, shown again without a request)   ↻ → translated anew
//   swipe → forgetTranslation   chat switch → resetTranslationState
//
// Paragraphs come from paragraphs.ts; parts the study scope skips (status
// windows, code) are not sent. Each saved translation carries its paragraph's
// text hash, so it finds its paragraph again when the page is drawn differently.
import { KEY } from './constants.js';
import { ST_SEL, mesSelector, mesIdOf, mesTextOf } from './st-dom.js';
import { paragraphTranslatePrompt } from './prompts.js';
import { notify } from './ui.manager.js';
import { t } from './i18n.js';
import { chatValue, currentChatId } from './storage.js';
import { getSettings, getLang, getNativeLang, completeText, getContext } from './runtime.js';
import { recordProblem } from './diagnostics.js';
import { entryList, withEntryFor } from './utils.js';
import { plainText, shownTextHashes } from './plain-text.js';
import { isRecord } from './ai/client.js';
import { paragraphsOf } from './paragraphs.js';
import { relocateSaves } from './message-saves.js';
import { skippedNodes, cleanRawMessage } from './study-scope.js';
import { textHash } from './furigana/model.js';
import { showStopBar, hideStopBar } from './stop-bar.js';
import { setLayer, hasLayer, resetLayers, pruneDetachedDecor, untilRendered, cancelUntilRendered, DECOR_CLASS, } from './ui/message-decor.js';
export const TRANS_CLASS = 'pg-para-trans';
const BUTTON_CLASS = 'pg-para-btn';
const store = chatValue(KEY.translations);
const KEEP_PER_MESSAGE = 6;
/** Translations drawn now, by mesId. */
const shown = new Map();
/** Requests in flight, by mesId. */
const requests = new Map();
/** The text each request translates (its hash): it finds its message again when ST renumbers them. */
const requestText = new Map();
const enabled = () => (getSettings().para_translate ?? 'button') !== 'off';
// ── Drawing ───────────────────────────────────────────────────────────────────
function translationBlock(item) {
    const block = Object.assign(document.createElement('div'), { className: `${TRANS_CLASS} ${DECOR_CLASS}` });
    item.t.split('\n').forEach((line, i) => { if (i)
        block.append(document.createElement('br')); block.append(line); });
    if (item.n)
        block.append(Object.assign(document.createElement('div'), { className: 'pg-para-note', textContent: item.n }));
    return block;
}
/** A small ↻ after the last translation: the reader asks for a new translation. */
function redoButton(onRedo) {
    const btn = Object.assign(document.createElement('span'), {
        className: 'pg-para-redo fa-solid fa-rotate-right', title: t('para.redo'), role: 'button', tabIndex: 0,
    });
    btn.addEventListener('click', e => { e.stopPropagation(); onRedo(btn); });
    btn.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ')
            return;
        e.preventDefault();
        btn.click();
    });
    return btn;
}
/** Draws each saved translation under its paragraph; with `onRedo`, the last one gets a ↻. */
export function drawTranslations(textEl, entry, onRedo) {
    const paragraphs = paragraphsOf(textEl, skippedNodes(textEl));
    const byKey = new Map(entry.p.map(item => [item.k, item]));
    // Drawn differently than when translated (another skip setting): fall back to the order
    const byOrder = paragraphs.length === entry.p.length;
    let last = null;
    paragraphs.forEach((p, i) => {
        const item = byKey.get(p.key) ?? (byOrder ? entry.p[i] : undefined);
        if (!item?.t)
            return;
        last = translationBlock(item);
        p.place(last);
    });
    if (last && onRedo)
        last.append(redoButton(onRedo));
}
export function stripTranslations(textEl) {
    textEl.querySelectorAll(`.${TRANS_CLASS}`).forEach(el => el.remove());
}
// ── Persistence ───────────────────────────────────────────────────────────────
const isItem = (x) => isRecord(x) && typeof x.k === 'string' && typeof x.t === 'string' && (x.n === undefined || typeof x.n === 'string');
const isEntry = (x) => isRecord(x) && typeof x.h === 'string' && Array.isArray(x.p) && x.p.every(isItem);
/** A message's saved translations; chat files can come from anywhere, so only well-formed ones count. */
const savedList = (mesId) => entryList(store.get()?.[mesId]).filter(isEntry);
function savedFor(mesId, textEl) {
    const h = textHash(plainText(textEl));
    return savedList(mesId).find(e => e.h === h);
}
function persist(mesId, entry) {
    store.set({ ...store.get(), [mesId]: withEntryFor(savedList(mesId), entry, KEEP_PER_MESSAGE) });
}
// ── Show / hide ───────────────────────────────────────────────────────────────
const buttonOf = (mesId) => document.querySelector(mesSelector(mesId))?.querySelector(`.${BUTTON_CLASS}`);
function show(mesId, entry) {
    shown.set(mesId, entry);
    setLayer(mesId, 'translation', { draw: el => drawTranslations(el, entry, redo), strip: stripTranslations });
    buttonOf(mesId)?.classList.add('pg-btn-active');
}
function takeDown(mesId) {
    setLayer(mesId, 'translation', null);
    shown.delete(mesId);
    buttonOf(mesId)?.classList.remove('pg-btn-active');
}
/** The 🌐 buttons show exactly which messages are translated now. */
function syncButtons() {
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach(btn => {
        const mesId = mesIdOf(btn);
        btn.classList.toggle('pg-btn-active', !!mesId && shown.has(mesId));
    });
}
// <t i="0">, also written <t i='0'>, <t i=0> or <t i = "0" …>
const TAG = /<([tn])\s+i\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/\1\s*>/g;
/**
 * The translations in a reply: <t i> per paragraph, <n i> its note. Only
 * closed tags count (a reply cut off mid-paragraph loses that paragraph);
 * indexes outside the message and repeats are ignored.
 */
export function parseTranslation(reply, count) {
    const texts = new Map(), notes = new Map();
    for (const [, kind, at, body] of reply.matchAll(TAG)) {
        const i = Number(at), value = body.trim();
        const into = kind === 't' ? texts : notes;
        if (i < count && value && !into.has(i))
            into.set(i, value);
    }
    return [...texts].sort(([a], [b]) => a - b).map(([i, text]) => ({ i, text, note: notes.get(i) ?? '' }));
}
/** The messages before the translated one that go with the request, whole. */
const CONTEXT_MESSAGES = 2;
/**
 * What the request is told about the chat: the names, the two messages just
 * before (whole; the user's is often in their own language, and shows how
 * they speak to the character) and the latest earlier translation (whole),
 * which is usually the character's message among those two: original and
 * translation side by side carry names, forms of address and register on.
 */
function contextFor(mesId) {
    const ctx = getContext();
    const index = Number(mesId);
    const chat = ctx.chat ?? [];
    const speaker = (i) => chat[i]?.name || (chat[i]?.is_user ? ctx.name1 : ctx.name2) || '?';
    // Hidden messages are not part of the story; status windows and code are left out as in study
    const before = [];
    for (let i = index - 1; i >= 0 && before.length < CONTEXT_MESSAGES; i--) {
        const message = chat[i];
        const mes = message && !message.is_system && typeof message.mes === 'string' ? cleanRawMessage(message.mes, getSettings()) : '';
        if (mes)
            before.unshift(`${speaker(i)}: ${mes}`);
    }
    // The translation of the text a message shows now (not of a swipe left behind)
    let lastTranslation = '';
    for (let i = index - 1; i >= 0 && !lastTranslation; i--) {
        const list = savedList(String(i));
        const textEl = list.length ? mesTextOf(String(i)) : null;
        const entry = textEl ? list.find(e => e.h === textHash(plainText(textEl))) : list.at(-1);
        if (entry?.p.length)
            lastTranslation = `${speaker(i)}: ${entry.p.map(p => p.t).join('\n\n')}`;
    }
    return { charName: ctx.name2, userName: ctx.name1, before, lastTranslation, wishes: getSettings().para_translate_wishes };
}
/**
 * Translates the message's paragraphs and shows them, in place of what was
 * shown; `auto` stays quiet when there is nothing to translate.
 */
async function translate(mesId, auto) {
    const textEl = mesTextOf(mesId);
    if (!textEl || requests.has(mesId))
        return;
    const paragraphs = paragraphsOf(textEl, skippedNodes(textEl));
    if (!paragraphs.length) {
        if (!auto)
            notify(t('para.nothing'), 'info', 3000);
        return;
    }
    const chatId = currentChatId();
    const hash = textHash(plainText(textEl));
    const abort = new AbortController();
    requests.set(mesId, abort);
    requestText.set(abort, hash);
    // Where the request is kept now (messages deleted meanwhile renumber it)
    const at = () => [...requests].find(([, a]) => a === abort)?.[0] ?? mesId;
    const busy = () => buttonOf(at());
    busy()?.classList.add('pg-btn-busy');
    showStopBar(abort, () => abort.abort(), t('para.translating'));
    try {
        const { system, user } = paragraphTranslatePrompt(paragraphs.map(p => p.text), getLang(), getNativeLang(), contextFor(mesId));
        const reply = await completeText(system, user, abort.signal);
        const data = parseTranslation(reply.text, paragraphs.length);
        if (!data.length) {
            recordProblem('ai', `Paragraph translation: no <t> tags${reply.truncated ? ' (cut off)' : ''}. Reply: ${reply.text.slice(0, 300)}`);
            throw new Error(t(reply.truncated ? 'para.cut' : 'para.unreadable'));
        }
        if (abort.signal.aborted || chatId !== currentChatId())
            return;
        // The message was swiped or edited while the reply was on its way: this translation is for another text
        const target = messageWith(hash, at());
        if (!target) {
            notify(t('para.changed'), 'info', 3500);
            return;
        }
        const byIndex = new Map(data.map(x => [x.i, x]));
        const entry = {
            h: hash,
            p: paragraphs.flatMap((p, i) => {
                const x = byIndex.get(i);
                return x ? [{ k: p.key, t: x.text, ...(x.note && { n: x.note }) }] : [];
            }),
        };
        show(target, entry);
        persist(target, entry);
        // Some paragraphs left out: shown as it is. Cut off by the token limit, ↻ would only stop there again
        if (entry.p.length < paragraphs.length)
            notify(t(reply.truncated ? 'para.cut' : 'para.partial'), 'warn', 5000);
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        console.error('[Polyglot] Paragraph translation error:', e);
        notify(t('para.error', { msg: e instanceof Error ? e.message : String(e) }), 'err', 3500);
    }
    finally {
        // A newer request for the message (after a swipe) keeps its busy mark
        const key = at();
        if (requests.get(key) === abort)
            requests.delete(key);
        requestText.delete(abort);
        if (!requests.has(key))
            buttonOf(key)?.classList.remove('pg-btn-busy');
        hideStopBar(abort);
    }
}
/** Where the message showing this text (its hash) is now: `mesId`, or where ST moved it; null when it changed. */
function messageWith(hash, mesId) {
    const textEl = mesTextOf(mesId);
    if (textEl && textHash(plainText(textEl)) === hash)
        return mesId;
    for (const [id, h] of shownTextHashes())
        if (h === hash && mesTextOf(id)?.closest(ST_SEL.aiMes))
            return id;
    return null;
}
/** ↻ under a translation: asked again, the new one replaces it. The id is read on click (ST renumbers). */
function redo(from) {
    const mesId = mesIdOf(from);
    if (mesId && !requests.has(mesId))
        void translate(mesId, false);
}
/** 🌐: shows the translation (asking for it the first time), hides it, or stops a request on its way. */
export function toggleTranslation(mesId) {
    if (!enabled())
        return;
    const running = requests.get(mesId);
    if (running) {
        running.abort();
        return;
    }
    const textEl = mesTextOf(mesId);
    if (!textEl)
        return;
    const current = shown.get(mesId);
    if (current) {
        takeDown(mesId);
        persist(mesId, { ...current, hidden: true });
        return;
    }
    const saved = savedFor(mesId, textEl);
    if (saved) {
        const entry = { h: saved.h, p: saved.p };
        show(mesId, entry);
        persist(mesId, entry);
        return;
    }
    void translate(mesId, false);
}
/**
 * A new character message with "auto": translated unless it is an older one or already has a translation.
 * `type` is what ST sends with the render: 'history' when it only draws a chat being opened.
 */
export function autoTranslate(mesId, type) {
    if (getSettings().para_translate !== 'auto' || type === 'history' || requests.has(mesId))
        return;
    const textEl = mesTextOf(mesId);
    const chat = getContext().chat ?? [];
    // Only the newest message: loading a chat must not translate all of it
    if (!textEl || !textEl.closest(ST_SEL.aiMes) || Number(mesId) !== chat.length - 1)
        return;
    if (savedFor(mesId, textEl))
        return;
    void translate(mesId, true);
}
// ── Buttons ───────────────────────────────────────────────────────────────────
/** Adds 🌐 to every character message that lacks it (or removes them all when translation is off). */
export function injectTranslateButtons() {
    if (!enabled()) {
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach(b => b.remove());
        return;
    }
    document.querySelectorAll(ST_SEL.aiMes).forEach(msgEl => {
        const extras = msgEl.querySelector(ST_SEL.extraMesButtons);
        if (!extras || msgEl.querySelector(`.${BUTTON_CLASS}`))
            return;
        const btn = Object.assign(document.createElement('div'), {
            className: `mes_button ${BUTTON_CLASS} fa-solid fa-language interactable`, title: t('para.button'), tabIndex: 0,
        });
        // The id is read on click: ST renumbers messages when one before them is deleted
        btn.addEventListener('click', () => { const id = mesIdOf(msgEl); if (id)
            toggleTranslation(id); });
        const annotate = extras.querySelector('.pg-annotate-btn');
        if (annotate)
            annotate.after(btn);
        else
            extras.prepend(btn);
        const id = mesIdOf(msgEl);
        if (id && shown.has(id))
            btn.classList.add('pg-btn-active');
    });
}
// ── Restore, follow, clear ────────────────────────────────────────────────────
/** Shows, on every message in the DOM, the saved translation of the text it shows now (unless hidden). */
export function restoreTranslations() {
    pruneDetachedDecor();
    for (const mesId of [...shown.keys()])
        if (!hasLayer(mesId, 'translation'))
            shown.delete(mesId);
    if (!enabled()) {
        syncButtons();
        return;
    }
    for (const [mesId, entry] of shown) {
        const textEl = mesTextOf(mesId);
        if (textEl && entry.h !== textHash(plainText(textEl)))
            takeDown(mesId);
    }
    for (const mesId of Object.keys(store.get() ?? {})) {
        if (shown.has(mesId))
            continue;
        const textEl = mesTextOf(mesId);
        const entry = textEl && savedFor(mesId, textEl);
        if (entry && !entry.hidden)
            show(mesId, entry);
    }
    syncButtons();
}
/** ST renders a loaded chat's messages asynchronously: keep restoring until they exist. */
export function restoreTranslationsWithRetry() {
    untilRendered('translation', Object.keys(store.get() ?? {}), restoreTranslations);
}
/**
 * Messages were deleted and ST renumbered the rest: saved translations follow
 * their messages. What is drawn is tracked by the old numbers, so it all goes
 * and the restore that follows draws each translation under its own message.
 */
export function relocateTranslations() {
    resetLayers('translation');
    shown.clear();
    document.querySelectorAll(`.${TRANS_CLASS}`).forEach(block => block.remove());
    relocateSaves(store);
    // Requests on their way follow their messages too (🌐 on a message stops its own request); one
    // whose message is gone stops, so it cannot hold a number another message now has
    const hashes = shownTextHashes();
    // Requests whose message kept its number go first, so none is pushed off its own message
    const before = [...requests].sort(([a, x], [b, y]) => Number(hashes.get(b) === requestText.get(y)) - Number(hashes.get(a) === requestText.get(x)));
    requests.clear();
    for (const [mesId, abort] of before) {
        const text = requestText.get(abort);
        const moved = hashes.get(mesId) === text ? mesId
            : [...hashes].find(([id, h]) => h === text && !requests.has(id) && mesTextOf(id)?.closest(ST_SEL.aiMes))?.[0];
        if (moved === undefined || requests.has(moved))
            abort.abort();
        else
            requests.set(moved, abort);
    }
}
/** The message shows other text (a swipe): its translation and request go; saved ones stay. */
export function forgetTranslation(mesId) {
    requests.get(mesId)?.abort();
    requests.delete(mesId);
    takeDown(mesId);
}
/** A chat switch: requests stop and what was drawn is forgotten (saved translations stay). */
export function resetTranslationState() {
    cancelUntilRendered('translation');
    requests.forEach(r => r.abort());
    requests.clear();
    resetLayers('translation');
    shown.clear();
}
/** Translation turned off: everything drawn goes (saved translations stay). */
export function hideAllTranslations() {
    requests.forEach(r => r.abort());
    for (const mesId of [...shown.keys()])
        takeDown(mesId);
}
