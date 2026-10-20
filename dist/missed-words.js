// Which words of a sentence speech recognition did not hear (shadowing): the
// sentence is cut into words (word by word for Japanese and Chinese too) and
// lined up with what was heard; a word with no counterpart was missed.
//
//   "Dove si trova la stazione?" + heard "dove si trova stazione"
//    → Dove si trova [la] stazione?
//
// Words count as the same when equal once case, accents and punctuation are
// set aside, or (from four letters) one letter apart — recognition often gets
// an ending slightly wrong for a word that was said.
//
// scoredWords() does the same with a pronunciation scoring service's verdict
// (Azure): words not said, and words said differently.
//
// Pure — no DOM.
import { levenshtein } from './utils.js';
const key = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');
/** The text in words and what lies between them, in order. */
export function pieces(text, lang) {
    if (typeof Intl.Segmenter === 'function') {
        try {
            return [...new Intl.Segmenter(lang || undefined, { granularity: 'word' }).segment(text)]
                .map(s => ({ text: s.segment, word: !!s.isWordLike && !!key(s.segment) }));
        }
        catch { /* a language tag the browser does not know: by letters below */ }
    }
    return text.split(/([\p{L}\p{M}\p{N}'’-]+)/u).filter(Boolean).map(t => ({ text: t, word: !!key(t) }));
}
const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && levenshtein(a, b) <= 1);
/** Pairs of positions (wanted word, said word) in the longest common run of words, in order. */
function align(want, said) {
    const table = Array.from({ length: want.length + 1 }, () => new Array(said.length + 1).fill(0));
    for (let i = want.length - 1; i >= 0; i--) {
        for (let j = said.length - 1; j >= 0; j--) {
            table[i][j] = same(want[i], said[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const pairs = new Map();
    for (let i = 0, j = 0; i < want.length && j < said.length;) {
        if (same(want[i], said[j])) {
            pairs.set(i, j);
            i++;
            j++;
        }
        else if (table[i + 1][j] >= table[i][j + 1])
            i++;
        else
            j++;
    }
    return pairs;
}
/** The sentence in pieces, the words not heard marked `missed` (none when nothing was heard). */
export function missedWords(target, heard, lang) {
    const parts = pieces(target, lang);
    const said = pieces(heard, lang).filter(p => p.word).map(p => key(p.text));
    if (!said.length)
        return parts;
    const words = parts.filter(p => p.word);
    const heardWords = align(words.map(p => key(p.text)), said);
    words.forEach((p, i) => { if (!heardWords.has(i))
        p.missed = true; });
    return parts;
}
/** Below this score a heard word counts as said differently. */
export const WRONG_BELOW = 60;
/**
 * The sentence in pieces with a scoring service's verdict on each word: not
 * said (`missed`), said differently (`wrong`), and its score. The service
 * splits words its own way (Japanese, numbers): its words are lined up with
 * the sentence's like heard words are, and a sentence word with no
 * counterpart counts as not said. Words the service heard but the sentence
 * does not have (Insertion) are left out.
 */
export function scoredWords(target, scored, lang) {
    const parts = pieces(target, lang);
    const said = scored.filter(w => w.error !== 'Insertion');
    const words = parts.filter(p => p.word);
    const pairs = align(words.map(p => key(p.text)), said.map(w => key(w.word)));
    words.forEach((p, i) => {
        const w = said[pairs.get(i) ?? -1];
        if (!w || w.error === 'Omission') {
            p.missed = true;
            return;
        }
        p.score = Math.round(w.score);
        if (w.error === 'Mispronunciation' || w.score < WRONG_BELOW)
            p.wrong = true;
    });
    return parts;
}
