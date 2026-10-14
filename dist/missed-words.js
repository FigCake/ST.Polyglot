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
/** The sentence in pieces, the words not heard marked `missed` (none when nothing was heard). */
export function missedWords(target, heard, lang) {
    const parts = pieces(target, lang);
    const said = pieces(heard, lang).filter(p => p.word).map(p => key(p.text));
    if (!said.length)
        return parts;
    const words = parts.filter(p => p.word);
    const want = words.map(p => key(p.text));
    // Longest common run of words (in order), then a walk back marks the target words in it
    const table = Array.from({ length: want.length + 1 }, () => new Array(said.length + 1).fill(0));
    for (let i = want.length - 1; i >= 0; i--) {
        for (let j = said.length - 1; j >= 0; j--) {
            table[i][j] = same(want[i], said[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const heardWords = new Set();
    for (let i = 0, j = 0; i < want.length && j < said.length;) {
        if (same(want[i], said[j])) {
            heardWords.add(i);
            i++;
            j++;
        }
        else if (table[i + 1][j] >= table[i][j + 1])
            i++;
        else
            j++;
    }
    words.forEach((p, i) => { if (!heardWords.has(i))
        p.missed = true; });
    return parts;
}
