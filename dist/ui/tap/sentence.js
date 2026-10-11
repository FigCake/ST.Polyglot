// Finding "the sentence the user pointed at" inside a chat message.
import { ST_SEL } from '../../st-dom.js';
const SENTENCE_END = /[.!?。！？\n]/;
/**
 * The sentence containing text[start, end): expands to the nearest sentence
 * terminators on both sides (the trailing terminator is kept).
 */
export function sentenceAround(text, start, end = start) {
    // A caret after the last character belongs to the last sentence
    let s = Math.max(0, Math.min(start, text.length - 1));
    while (s > 0 && !SENTENCE_END.test(text[s - 1]))
        s--;
    let e = Math.max(s, Math.min(end, text.length));
    while (e < text.length && !SENTENCE_END.test(text[e]))
        e++;
    return text.slice(s, e < text.length ? e + 1 : e).trim();
}
/** The message text element (`.mes_text`) that contains `node`, if any. */
export function messageTextOf(node) {
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    return el?.closest(ST_SEL.mesText) ?? null;
}
