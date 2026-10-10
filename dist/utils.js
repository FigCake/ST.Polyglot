// ════════════════════════════
// Polyglot  utils.ts
// ════════════════════════════
// Pure utility functions — no side effects, no DOM, no API calls.
// Dependencies: constants.ts (resolveNativeLang).
import { resolveNativeLang } from './constants.js';
// ── Language helpers ───────────────────────────────────────────────────────────
// These helpers extract the resolved language strings from a Settings object.
// Defined here (not in index.ts) so annotator.ts, wordbook.ts, and index.ts
// can all share the same logic without creating a circular dependency.
/**
 * Returns the current learning language string from settings.
 * Falls back to 'English' when the language is absent or set to 'Custom'
 * without a custom value.
 */
export function getLangFromSettings(s) {
    return s?.language === 'Custom'
        ? (s.language_custom || 'English')
        : (s?.language || 'English');
}
/**
 * Returns the resolved native-language name for use in AI prompts
 * (e.g. "Korean", "English", "Italian").
 */
export function getNativeLangFromSettings(s) {
    return resolveNativeLang(s?.native_lang ?? 'en', s?.native_lang_custom ?? '');
}
// ── Array utilities ───────────────────────────────────────────────────────────
/**
 * Fisher-Yates shuffle — unbiased O(n), returns a new array (non-mutating).
 * Use instead of .sort(() => Math.random() - 0.5) which is biased and O(n log n).
 */
/** Whether a study-language name is Japanese. */
export const isJapanese = (lang) => /japanese|日本語/i.test(lang);
export function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
// ── Level display helpers ─────────────────────────────────────────────────────
// Used by annotator.ts, wordbook-ui.ts, and flashcard.ts.
/** Converts a CEFR level label to its CSS class name. */
export function levelClass(level) {
    if (!level)
        return 'grammar';
    if (level === 'grammar')
        return 'grammar';
    if (level === 'sentence')
        return 'sentence';
    if (level === 'idiom')
        return 'idiom';
    return level; // A1–C2 map to themselves
}
/** Human-readable label for a level value. */
export function levelLabel(level) {
    if (!level)
        return '?';
    if (level === 'grammar')
        return 'Gram.';
    if (level === 'sentence')
        return 'Sent.';
    if (level === 'idiom')
        return 'Idiom';
    return level; // A1–C2 as-is
}
// ── String similarity ──────────────────────────────────────────────────────────
/** Levenshtein edit distance (rolling single-row DP — O(min) memory). */
export function levenshtein(a, b) {
    if (!a.length)
        return b.length;
    if (!b.length)
        return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const curr = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        prev = curr;
    }
    return prev[b.length];
}
/** Similarity of two strings as a 0–100 score, based on Levenshtein distance. */
export function similarityScore(a, b) {
    if (a === b)
        return 100;
    const dist = levenshtein(a, b);
    return Math.max(0, Math.round(100 * (1 - dist / Math.max(a.length, b.length))));
}
// ── Finding a word in running text ────────────────────────────────────────────
const WORD_CHAR = /[\p{L}\p{N}]/u;
/** Scripts written without spaces: words sit side by side, so a letter next door is no boundary. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー]/u;
const HANGUL = /\p{Script=Hangul}/u;
/** Whether `neighbor` glues onto the word whose edge character is `edge` (so it is not a match). */
function glued(neighbor, edge, after) {
    if (!neighbor || !WORD_CHAR.test(neighbor))
        return false;
    if (UNSPACED.test(neighbor) || UNSPACED.test(edge))
        return false;
    // Korean particles and endings follow the word: 학교 in 학교에
    if (after && HANGUL.test(neighbor) && HANGUL.test(edge))
        return false;
    return true;
}
/**
 * Index of the first occurrence of `word` in `text` at or after `from` that
 * stands as a word: not part of a longer word in a spaced script ("art" is
 * not found in "start"), while Japanese, Chinese, Thai… and Korean particles
 * need no spaces around it. -1 when there is none.
 */
export function findWord(text, word, from = 0) {
    if (!word)
        return -1;
    for (let at = text.indexOf(word, from); at !== -1; at = text.indexOf(word, at + 1)) {
        if (glued(text[at - 1], word[0], false))
            continue;
        if (glued(text[at + word.length], word[word.length - 1], true))
            continue;
        return at;
    }
    return -1;
}
