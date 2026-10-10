// ════════════════════════════
// Polyglot  furigana/messages.ts
// ════════════════════════════
// Furigana on chat messages, part of message analysis (📖) while the study
// language is Japanese and "Use furigana" is on.
//
//   📖 analyse ─┬─▶ annotation request      ─▶ highlights
//               └─▶ readings (in parallel)   ─▶ ruby        saved { hash, spans }
//   📖 again   ─▶ both removed (readings stay saved for next time)
//   click a reading ─▶ edit it (empty = remove that ruby)
//
// Readings are saved per message in the chat's metadata with a hash of the
// message text; when the text changes (edit, swipe, a renumbered message)
// they are no longer used. Display (always / on hover) and size are global
// settings applied with CSS. An optional auto mode adds readings to new AI
// messages without analysing them.
//
// Dependencies: constants.ts, utils.ts, storage.ts, runtime.ts, ui.manager.ts, i18n.ts,
//               plain-text.ts, ui/message-decor.ts, furigana/*
import { KEY } from '../constants.js';
import { isJapanese } from '../utils.js';
import { chatValue, currentChatId } from '../storage.js';
import { getSettings, getLang, ai } from '../runtime.js';
import { notify, askInput } from '../ui.manager.js';
import { t } from '../i18n.js';
import { plainText } from '../plain-text.js';
import { setLayer, hasLayer, messagesWith, resetLayers, untilRendered, cancelUntilRendered } from '../ui/message-decor.js';
import { fetchReadings } from './request.js';
import { drawRuby, stripRuby } from './render.js';
import { hasKanji, isKana, textHash, toHiragana } from './model.js';
const store = chatValue(KEY.furigana);
const requests = new Map();
const textOf = (mesId) => document.querySelector(`.mes[mesid="${CSS.escape(mesId)}"] .mes_text`);
/** Furigana is used while the study language is Japanese and the user has it on. */
export const furiganaEnabled = () => isJapanese(getLang()) && getSettings().furigana_enabled !== false;
// ── Saved readings ────────────────────────────────────────────────────────────
const saved = (mesId) => store.get()?.[mesId];
function save(mesId, readings) {
    store.set({ ...store.get(), [mesId]: readings });
}
/** Readings saved for the message's current text, if any. */
function currentReadings(mesId, text, dialogue = false) {
    const entry = saved(mesId);
    return entry?.h === textHash(text) && !!entry.d === dialogue ? entry : undefined;
}
// ── Showing ───────────────────────────────────────────────────────────────────
function show(mesId, readings) {
    setLayer(mesId, 'furigana', {
        // ST may re-render the message with other text (edit, swipe): never draw stale readings
        draw: textEl => { if (textHash(plainText(textEl)) === readings.h)
            drawRuby(textEl, readings.s); },
        strip: stripRuby,
    });
}
const hide = (mesId) => setLayer(mesId, 'furigana', null);
// ── Generating ────────────────────────────────────────────────────────────────
/** Fetches, saves and shows readings for a message. Quiet = automatic: no notices except errors. */
async function generate(mesId, text, quiet, lines) {
    const chatId = currentChatId();
    const abort = new AbortController();
    requests.set(mesId, abort);
    try {
        const { spans, uncovered } = await fetchReadings(text, ai, abort.signal, lines);
        if (abort.signal.aborted || chatId !== currentChatId())
            return;
        // The message may have changed while we waited
        const now = textOf(mesId);
        if (!now || plainText(now) !== text)
            return;
        const readings = { h: textHash(text), s: spans, ...(lines && { d: true }) };
        save(mesId, readings);
        show(mesId, readings);
        if (!quiet && uncovered.length)
            notify(t('furi.partial', { n: uncovered.length }), 'warn', 4000);
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        console.error('[Polyglot] furigana error:', e);
        notify(t('furi.error', { msg: e instanceof Error ? e.message : String(e) }), 'err', 4000);
    }
    finally {
        if (requests.get(mesId) === abort)
            requests.delete(mesId);
    }
}
/**
 * Adds readings to an analysed message: saved ones at once, otherwise a
 * request that runs alongside the annotation request. Resolves when done.
 */
export async function showFuriganaFor(mesId, lines) {
    if (!furiganaEnabled() || requests.has(mesId))
        return;
    const textEl = textOf(mesId);
    if (!textEl)
        return;
    const text = plainText(textEl);
    if (!hasKanji(lines ? lines.map(l => text.slice(l.start, l.end)).join('') : text))
        return;
    const ready = currentReadings(mesId, text, !!lines);
    if (ready) {
        save(mesId, { ...ready, hidden: false });
        show(mesId, ready);
        return;
    }
    await generate(mesId, text, false, lines);
}
/** The message's analysis was removed or stopped: cancel and hide its readings (kept saved). */
export function hideFuriganaFor(mesId) {
    requests.get(mesId)?.abort();
    requests.delete(mesId);
    hide(mesId);
    const entry = saved(mesId);
    if (entry && !entry.hidden)
        save(mesId, { ...entry, hidden: true });
}
// ── Editing a reading ─────────────────────────────────────────────────────────
/** Asks for a corrected reading of one ruby and saves it (an empty answer removes the ruby). */
async function editReading(ruby) {
    const mesId = ruby.closest('.mes')?.getAttribute('mesid');
    const index = Number(ruby.dataset.pgSpan);
    const entry = mesId ? saved(mesId) : undefined;
    const span = entry?.s[index];
    if (!mesId || !entry || !span)
        return;
    const base = ruby.firstChild?.textContent ?? '';
    const answer = await askInput(t('furi.editTitle', { word: base }), { initial: span[2], hint: t('furi.editHint') });
    if (answer === null)
        return;
    const reading = toHiragana(answer.replace(/\s+/g, ''));
    if (reading && !isKana(reading)) {
        notify(t('furi.editKana'), 'warn', 3000);
        return;
    }
    // Re-read: the readings may have changed while the dialog was open
    const current = saved(mesId);
    if (!current || current.h !== entry.h || !current.s[index])
        return;
    const spans = reading
        ? current.s.map((s, i) => (i === index ? [s[0], s[1], reading] : s))
        : current.s.filter((_, i) => i !== index);
    const next = { ...current, s: spans };
    save(mesId, next);
    if (hasLayer(mesId, 'furigana'))
        show(mesId, next);
}
/** Clicking a reading on a message edits it (before highlight clicks open the panel). */
export function setupReadingEditor() {
    document.addEventListener('click', e => {
        const rt = e.target?.closest?.('rt');
        const ruby = rt?.closest('ruby.pg-ruby[data-pg-span]');
        if (!ruby || !ruby.closest('.mes_text'))
            return;
        e.preventDefault();
        e.stopPropagation();
        void editReading(ruby);
    }, { capture: true });
}
// ── Restore / auto / reset ────────────────────────────────────────────────────
/** Shows saved, non-hidden readings on messages that are in the DOM and match them. */
export function restoreFurigana() {
    if (!furiganaEnabled())
        return;
    for (const [mesId, entry] of Object.entries(store.get() ?? {})) {
        if (entry.hidden || hasLayer(mesId, 'furigana'))
            continue;
        const textEl = textOf(mesId);
        if (textEl && textHash(plainText(textEl)) === entry.h)
            show(mesId, entry);
    }
}
/** Restores as ST finishes rendering a loaded chat. */
export function restoreFuriganaWithRetry() {
    untilRendered('furigana', Object.keys(store.get() ?? {}), restoreFurigana);
}
/** Automatic readings for a newly rendered AI message (setting "auto"); one request at a time. */
let autoQueue = Promise.resolve();
export function autoFurigana(mesId) {
    if (!furiganaEnabled() || !getSettings().furigana_auto)
        return;
    if (saved(mesId)?.hidden || requests.has(mesId))
        return;
    autoQueue = autoQueue.then(async () => {
        const textEl = textOf(mesId);
        if (!textEl || textEl.closest('.mes')?.getAttribute('is_user') !== 'false')
            return;
        const text = plainText(textEl);
        if (!hasKanji(text) || requests.has(mesId))
            return;
        const ready = currentReadings(mesId, text);
        if (ready) {
            if (!hasLayer(mesId, 'furigana'))
                show(mesId, ready);
            return;
        }
        await generate(mesId, text, true);
    });
}
/** A swiped message gets new text: drop its readings and any request. */
export function forgetFurigana(mesId) {
    requests.get(mesId)?.abort();
    requests.delete(mesId);
    hide(mesId);
    const { [mesId]: gone, ...rest } = store.get() ?? {};
    if (gone)
        store.set(rest);
}
/** Deletes every saved reading of the open chat (with "clear this chat's annotations"). */
export function clearChatFurigana() {
    messagesWith('furigana').forEach(hide);
    resetFuriganaState();
    store.delete();
}
/** Chat switch: cancel requests and forget what is drawn (saved readings stay). */
export function resetFuriganaState() {
    cancelUntilRendered('furigana');
    requests.forEach(r => r.abort());
    requests.clear();
    resetLayers('furigana');
    autoQueue = Promise.resolve();
}
/** The study language or "Use furigana" changed: show or hide readings everywhere. */
export function onFuriganaSettingChange() {
    applyFuriganaDisplay();
    if (furiganaEnabled())
        restoreFurigana();
    else
        messagesWith('furigana').forEach(hide);
}
/** Applies the display settings (always / on hover, size, off) to the page. */
export function applyFuriganaDisplay() {
    const s = getSettings();
    document.body.classList.toggle('pg-furi-hover', s.furigana_display === 'hover');
    document.body.classList.toggle('pg-furi-off', !furiganaEnabled());
    document.body.style.setProperty('--pg-furi-size', `${s.furigana_size ?? 0.65}em`);
}
/**
 * Browsers raise text below their minimum font size (Chrome: Settings →
 * Appearance → Customize fonts), which makes every reading size look alike.
 * Measures a shown reading and says so when it was enlarged.
 */
export function warnIfFontClamped() {
    const rt = document.querySelector('.mes_text ruby.pg-ruby rt');
    const base = rt?.parentElement;
    if (!rt || !base)
        return;
    const wanted = parseFloat(getComputedStyle(base).fontSize) * (getSettings().furigana_size ?? 0.65);
    const actual = parseFloat(getComputedStyle(rt).fontSize);
    if (actual > wanted + 0.5)
        notify(t('furi.sizeClamped', { px: Math.round(actual) }), 'warn', 8000);
}
