// How today's review asks for a word. A word keeps one schedule (srs.ts);
// the question changes from review to review:
//
//   meaning  word → meaning (always for a new word, and in browse mode)
//   cloze    the word's saved example with the word blanked, translation below
//   typing   meaning → type the word
//
// The kind comes from the word and its last review time, so it changes after
// each rating with nothing stored. The flashcard session keeps the kind it
// first showed for a card (an example arriving later must not turn a card
// whose answer was seen into a cloze).
import { findWord, UNSPACED } from './utils.js';
import { isNew } from './srs.js';
import { gradeTyped } from './features/writing-model.js';
import { fnv1a } from './hash.js';
/** Phrases longer than this many words are not asked to be typed. */
const TYPING_MAX_WORDS = 4;
/** Shortest base form whose stem is looked for ("parlare" → "parlo"). */
const STEM_MIN = 4;
/** How much longer than the base form a word sharing its stem may be ("parlare" → "parlavamo", not "parlamentare"). */
const STEM_SLACK = 3;
/** `text` cut at every whole-word occurrence of `needle` (searched in `hay`, the same text in another case). */
function cut(text, hay, needle, length) {
    const parts = [];
    let from = 0;
    for (let at = findWord(hay, needle); at !== -1; at = findWord(hay, needle, at + length)) {
        parts.push(text.slice(from, at));
        from = at + length;
    }
    if (!parts.length)
        return null;
    const first = parts[0].length;
    parts.push(text.slice(from));
    return { parts, answer: text.slice(first, first + length) };
}
/**
 * Where the word stands in its example: the form the AI said it used, else the
 * word, base form or original form (any case), else, in a spaced script, the
 * word in the sentence that shares the most of the base form's stem. Every
 * place it stands is blanked, so it never shows elsewhere in the sentence.
 * Null when it is not there.
 */
export function clozeOf(w) {
    const text = w.example?.trim();
    if (!text)
        return null;
    // Case-insensitive where lowercasing keeps every index in place
    const lower = text.toLocaleLowerCase();
    const hay = lower.length === text.length ? lower : text;
    for (const form of [w.example_form, w.word, w.base_form, w.original_form]) {
        const f = form?.trim();
        if (!f)
            continue;
        const needle = hay === lower && f.toLocaleLowerCase().length === f.length ? f.toLocaleLowerCase() : f;
        const found = cut(text, hay, needle, f.length);
        if (found)
            return found;
    }
    // A stem means nothing in a script without spaces: a "word" there is a whole clause
    const base = (w.base_form || w.word).toLocaleLowerCase();
    if (base.length < STEM_MIN || /\s/.test(base) || UNSPACED.test(base) || hay !== lower)
        return null;
    const stem = base.slice(0, Math.max(STEM_MIN, base.length - 3));
    let best = null;
    for (const [token] of lower.matchAll(/[\p{L}\p{M}]+/gu)) {
        if (!token.startsWith(stem) || token.length > base.length + STEM_SLACK)
            continue;
        let shared = stem.length;
        while (shared < base.length && token[shared] === base[shared])
            shared++;
        // Most shared, then the closest in length ("parla" over "parlamento")
        const closer = best && shared === best.shared && Math.abs(token.length - base.length) < Math.abs(best.token.length - base.length);
        if (!best || shared > best.shared || closer)
            best = { token, shared };
    }
    return best && cut(text, lower, best.token, best.token.length);
}
/** A stable pick from a string. */
const hash = fnv1a;
/** How today's review asks for `w`. */
export function cardKind(w) {
    if (isNew(w))
        return 'meaning';
    const kinds = ['meaning'];
    if (clozeOf(w))
        kinds.push('cloze');
    if (w.word.trim().split(/\s+/).length <= TYPING_MAX_WORDS)
        kinds.push('typing');
    return kinds[hash(`${w.word}\n${w.srs_reviewed_at ?? 0}`) % kinds.length];
}
/** Grades a typed answer against the word, its base form and its reading. */
export function gradeWord(w, input) {
    return gradeTyped(input, [w.word, w.base_form, w.reading].filter((s) => !!s?.trim()));
}
