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
import { KEY } from '../constants.js';
import { ST_SEL, mesTextOf, mesIdOf } from '../st-dom.js';
import { isJapanese, entryList, withEntryFor } from '../utils.js';
import { chatValue, currentChatId } from '../storage.js';
import { getSettings, getLang, ai } from '../runtime.js';
import { notify, askInput } from '../ui.manager.js';
import { t } from '../i18n.js';
import { plainText } from '../plain-text.js';
import { setLayer, hasLayer, messagesWith, resetLayers, untilRendered, cancelUntilRendered } from '../ui/message-decor.js';
import { fetchReadings } from './request.js';
import { drawRuby, stripRuby } from './render.js';
import { hasKanji, isKana, textHash, toHiragana } from './model.js';
/** Saved readings by message index: one entry per text the message has shown (older saves: a single entry). */
const store = chatValue(KEY.furigana);
const KEEP_PER_MESSAGE = 6;
const requests = new Map();
/** Furigana is used while the study language is Japanese and the user has it on. */
export const furiganaEnabled = () => isJapanese(getLang()) && getSettings().furigana_enabled !== false;
// ── Saved readings ────────────────────────────────────────────────────────────
const savedList = (mesId) => entryList(store.get()?.[mesId]);
/** Readings saved for the text the message shows now, if any. */
function saved(mesId) {
    const textEl = mesTextOf(mesId);
    if (!textEl)
        return undefined;
    const h = textHash(plainText(textEl));
    return savedList(mesId).find(e => e.h === h);
}
function save(mesId, readings) {
    store.set({ ...store.get(), [mesId]: withEntryFor(savedList(mesId), readings, KEEP_PER_MESSAGE) });
}
/** Readings saved for the message's current text, if any. */
function currentReadings(mesId, text, dialogue = false) {
    const h = textHash(text);
    return savedList(mesId).find(e => e.h === h && !!e.d === dialogue);
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
        const now = mesTextOf(mesId);
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
    const textEl = mesTextOf(mesId);
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
    const mesId = mesIdOf(ruby);
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
        if (!ruby || !ruby.closest(ST_SEL.mesText))
            return;
        e.preventDefault();
        e.stopPropagation();
        void editReading(ruby);
    }, { capture: true });
}
// ── Restore / auto / reset ────────────────────────────────────────────────────
/** Shows saved, non-hidden readings on messages that are in the DOM, for the text each shows now. */
export function restoreFurigana() {
    if (!furiganaEnabled())
        return;
    for (const mesId of Object.keys(store.get() ?? {})) {
        if (hasLayer(mesId, 'furigana'))
            continue;
        const entry = saved(mesId);
        if (entry && !entry.hidden)
            show(mesId, entry);
    }
}
/** Restores as ST finishes rendering a loaded chat. */
export function restoreFuriganaWithRetry() {
    untilRendered('furigana', Object.keys(store.get() ?? {}), restoreFurigana);
}
/** Automatic readings for a newly rendered AI message (setting "auto"); one request at a time. */
let autoQueue = Promise.resolve();
/** Bumped on a chat switch: tasks queued before it belong to the old chat and do nothing. */
let autoGeneration = 0;
export function autoFurigana(mesId) {
    if (!furiganaEnabled() || !getSettings().furigana_auto)
        return;
    if (saved(mesId)?.hidden || requests.has(mesId))
        return;
    const generation = autoGeneration;
    autoQueue = autoQueue.then(async () => {
        if (generation !== autoGeneration)
            return;
        const textEl = mesTextOf(mesId);
        if (!textEl || !textEl.closest(ST_SEL.aiMes))
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
/** A swiped message shows other text: its readings and request go; readings saved per text stay. */
export function forgetFurigana(mesId) {
    requests.get(mesId)?.abort();
    requests.delete(mesId);
    hide(mesId);
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
    autoGeneration++;
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
    const rt = document.querySelector(`${ST_SEL.mesText} ruby.pg-ruby rt`);
    const base = rt?.parentElement;
    if (!rt || !base)
        return;
    const wanted = parseFloat(getComputedStyle(base).fontSize) * (getSettings().furigana_size ?? 0.65);
    const actual = parseFloat(getComputedStyle(rt).fontSize);
    if (actual > wanted + 0.5)
        notify(t('furi.sizeClamped', { px: Math.round(actual) }), 'warn', 8000);
}
