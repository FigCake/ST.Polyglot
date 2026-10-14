// A small ▶ after each line of dialogue in character messages: pressing it
// reads the line aloud with the voice chosen in the settings (voice.ts — the
// browser's voice, ST's TTS, or a voice service), in the study language and
// the voice of the message's character (voice-cast.ts). Pressing it again
// while it reads stops it. The message's 🎧 button reads all its lines in turn.
// Beside it (shown when pointed at, always on touch screens) a bookmark saves
// the line to the wordbook as a sentence: to hear it again there, and to say it
// after the voice in the speaking drill.
//
//   “Ciao, come stai?” ▶🔖 she asked. 「元気？」 ▶🔖     —Hola ▶🔖 —dijo.
//
// Lines are what dialogue.ts finds (the quotation marks of every language,
// apostrophes told apart from single quotes, dash dialogue); lines in skipped
// parts (status windows…) and lines without letters get no button.
//
// The buttons are the 'voice' layer of message-decor.ts, drawn last. They are
// empty elements (the icon is drawn by CSS), so the message's plain text — and
// the offsets highlights and furigana use — stay the same.
import { DECOR_CLASS, setLayer, hasLayer, messagesWith, resetLayers } from './message-decor.js';
import { ST_SEL, mesIdOf, mesTextOf } from '../st-dom.js';
import { plainText, plainTextNodes } from '../plain-text.js';
import { messageLines } from '../study-scope.js';
import { speak, speakAll, stopSpeaking } from '../voice.js';
import { getSettings, getLang, getContext } from '../runtime.js';
import { t } from '../i18n.js';
import { PLAY_CLASS, playGlyph, pressGlyph, showPlaying, isPlaying } from './play-glyph.js';
import { loadWordbook, addToWordbook } from '../wordbook.js';
import { SENTENCE_MAX } from '../wordbook-model.js';
import { notify } from '../ui.manager.js';
const ALL_CLASS = 'pg-lines-play-btn';
/** A line's ▶ and bookmark, together (pointing at the pair shows the bookmark). */
const TOOLS_CLASS = 'pg-line-tools';
const SAVE_CLASS = 'pg-line-save';
const PLAYING = 'pg-playing';
const enabled = () => getSettings().line_voice !== false;
/** The lines a message's buttons read. */
function spokenLines(textEl) {
    const plain = plainText(textEl);
    return messageLines(textEl, plain)
        .map(l => ({ text: plain.slice(l.start, l.end).trim(), after: l.after }))
        .filter(l => /\p{L}/u.test(l.text));
}
/** The character a message is from: whose voice reads its lines. */
function speakerOf(textEl) {
    const mes = textEl.closest(ST_SEL.mes);
    const id = mesIdOf(mes);
    const name = id !== null ? getContext().chat?.[Number(id)]?.name : undefined;
    return typeof name === 'string' && name ? name : mes?.getAttribute('ch_name') ?? undefined;
}
/** A line's ▶ (play-glyph.ts), in the message character's voice. */
function playButton(text) {
    const btn = playGlyph(`${t('line.play')}: ${text}`, el => pressGlyph(el, () => speak(text, getLang(), { speaker: speakerOf(el) })));
    btn.title = t('line.play');
    btn.classList.add(DECOR_CLASS);
    // A quick second press is not a double-click on the sentence (tap translation)
    btn.addEventListener('dblclick', e => e.stopPropagation());
    return btn;
}
/** Shows a line's bookmark as saved. */
function showSaved(el) {
    el.classList.replace('fa-regular', 'fa-solid');
    el.classList.add('pg-saved');
    el.title = t('line.saved');
    el.setAttribute('aria-label', t('line.saved'));
}
/** A line's bookmark: saves it to the wordbook as a sentence (once), with who said it (whose voice reads it again). */
function saveButton(text, saved) {
    const el = playGlyph(t('line.save'), () => {
        if (el.classList.contains('pg-saved'))
            return;
        const speaker = speakerOf(el);
        addToWordbook({ word: text.slice(0, SENTENCE_MAX), base_form: '', meaning: '', level: 'sentence', ...(speaker && { speaker }) }, { quiet: true });
        document.querySelectorAll(`.${SAVE_CLASS}`).forEach(b => { if (b.dataset.line === text)
            showSaved(b); });
        notify(t('line.savedNote'), 'info', 3000);
    });
    el.className = `${SAVE_CLASS} fa-regular fa-bookmark`;
    el.dataset.line = text;
    if (saved)
        showSaved(el);
    el.addEventListener('dblclick', e => e.stopPropagation());
    return el;
}
/** Reads all of a message's lines in turn (its 🎧 button); pressed again, stops. */
async function playAll(msgEl, allBtn) {
    if (allBtn.classList.contains(PLAYING)) {
        stopSpeaking();
        return;
    }
    const id = mesIdOf(msgEl);
    const textEl = id !== null ? mesTextOf(id) : null;
    if (!textEl)
        return;
    const speaker = speakerOf(textEl);
    const lines = spokenLines(textEl).map(l => ({ text: l.text, speaker }));
    allBtn.classList.add(PLAYING);
    let current = null;
    try {
        await speakAll(lines, getLang(), i => {
            if (i >= 0)
                showPlaying(current = textEl.querySelectorAll(`.${PLAY_CLASS}`)[i] ?? null);
            else if (isPlaying(current))
                showPlaying(null);
        });
    }
    finally {
        allBtn.classList.remove(PLAYING);
    }
}
/** Adds (or, with no lines, removes) a message's 🎧 button in its button row. */
function setAllButton(msgEl, on) {
    const extras = msgEl?.querySelector(ST_SEL.extraMesButtons);
    const existing = msgEl?.querySelector(`.${ALL_CLASS}`);
    if (!on) {
        existing?.remove();
        return;
    }
    if (!extras || existing)
        return;
    const btn = Object.assign(document.createElement('div'), {
        className: `mes_button ${ALL_CLASS} fa-solid fa-headphones interactable`, title: t('line.playAll'), tabIndex: 0,
    });
    btn.addEventListener('click', () => { if (msgEl)
        void playAll(msgEl, btn); });
    extras.prepend(btn);
}
function draw(textEl) {
    const lines = spokenLines(textEl);
    if (!lines.length)
        return;
    const nodes = [];
    let offset = 0;
    for (const node of plainTextNodes(textEl)) {
        nodes.push({ node, start: offset });
        offset += node.data.length;
    }
    const saved = new Set(loadWordbook().filter(e => e.level === 'sentence').map(e => e.word));
    // From the last line back: splitting a node keeps the text before the cut in it
    for (const line of [...lines].reverse()) {
        const last = line.after - 1;
        const at = nodes.find(n => last >= n.start && last < n.start + n.node.data.length);
        if (!at)
            continue;
        const cut = line.after - at.start;
        if (cut < at.node.data.length)
            at.node.splitText(cut);
        const tools = document.createElement('span');
        tools.className = `${TOOLS_CLASS} ${DECOR_CLASS}`;
        tools.append(playButton(line.text), saveButton(line.text, saved.has(line.text.slice(0, SENTENCE_MAX))));
        at.node.after(tools);
    }
}
function strip(textEl) {
    textEl.querySelectorAll(`.${TOOLS_CLASS}`).forEach(b => b.remove());
    textEl.normalize();
}
const DECORATION = { draw, strip };
/** The lines each message's buttons were drawn for, so an unchanged message is not redrawn. */
const shown = new Map();
/** Puts the buttons on every character message on screen, or on the given ones. */
export function refreshLineVoice(mesIds) {
    if (!enabled()) {
        clearLineVoice();
        return;
    }
    const ids = mesIds ?? [...document.querySelectorAll(ST_SEL.aiMes)].map(el => mesIdOf(el)).filter((id) => !!id);
    for (const mesId of ids) {
        const textEl = mesTextOf(mesId);
        if (!textEl || textEl.closest(ST_SEL.mes)?.getAttribute('is_user') === 'true')
            continue;
        // Read with the buttons in place: they hold no text
        const key = spokenLines(textEl).map(l => l.text).join('\u0001');
        setAllButton(textEl.closest(ST_SEL.mes), !!key);
        if (shown.get(mesId) === key && (hasLayer(mesId, 'voice') || !key))
            continue;
        shown.set(mesId, key);
        setLayer(mesId, 'voice', key ? DECORATION : null);
    }
}
/** Takes every button down (the setting was turned off). */
export function clearLineVoice() {
    for (const mesId of messagesWith('voice'))
        setLayer(mesId, 'voice', null);
    document.querySelectorAll(`.${ALL_CLASS}`).forEach(b => b.remove());
    shown.clear();
}
/** Forgets what was drawn (chat switch: the messages are new). */
export function resetLineVoice() {
    shown.clear();
    resetLayers('voice');
}
