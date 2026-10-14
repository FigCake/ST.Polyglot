// The small ▶ that reads a text aloud: after lines of dialogue in chat
// (line-voice.ts) and after saved sentences in the wordbook. One look and one
// behaviour for both: a bare icon (no border or fill, whatever the theme),
// a ■ while it reads, and pressed again, it stops.
//
//   playGlyph(label)          the element (chat: built in the DOM)
//   playGlyphHtml(label)      the same as markup (lists drawn from HTML)
//   pressGlyph(el, read)      what a press does: read, or stop if it is reading
//   showPlaying(el | null)    marks the icon reading now (a run of lines moves it along)
import { html } from '../html.js';
import { stopSpeaking } from '../voice.js';
export const PLAY_CLASS = 'pg-line-play';
const PLAYING = 'pg-playing';
/** The icon reading now. */
let playing = null;
export const isPlaying = (el) => !!el && el === playing;
/** Shows `el` as reading (its ▶ becomes ■), and the one before as not. */
export function showPlaying(el) {
    playing?.classList.remove(PLAYING, 'fa-stop');
    playing?.classList.add('fa-play');
    playing = el;
    el?.classList.remove('fa-play');
    el?.classList.add(PLAYING, 'fa-stop');
}
/** A press: stops the reading when this icon is reading, else reads and shows it until the reading ends. */
export function pressGlyph(el, read) {
    if (el.classList.contains(PLAYING)) {
        stopSpeaking();
        return;
    }
    showPlaying(el);
    void read().finally(() => { if (playing === el)
        showPlaying(null); });
}
/**
 * A bare icon, not a <button>: ST themes, custom CSS and phones style buttons
 * (border, fill on hover, size), and this should look like a glyph in the text.
 * Enter and Space press it.
 */
export function playGlyph(label, onPress) {
    const el = document.createElement('span');
    el.className = `${PLAY_CLASS} fa-solid fa-play`;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = label;
    el.setAttribute('aria-label', label);
    el.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        onPress(el);
    });
    el.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ')
            return;
        e.preventDefault();
        el.click();
    });
    return el;
}
/** The icon as markup, for lists drawn from HTML; `action` is its data-action (the list dispatches on it). */
export const playGlyphHtml = (label, title, action) => html `
    <span class="${PLAY_CLASS} fa-solid fa-play" role="button" tabindex="0" data-action="${action}" title="${title}" aria-label="${label}"></span>`;
