// Pure utility functions: no side effects, no DOM, no API calls.
import { resolveNativeLang } from './constants.js';
// ── Language helpers ───────────────────────────────────────────────────────────
/** The learning language; 'English' when unset or 'Custom' without a value. */
export function getLangFromSettings(s) {
    return s?.language === 'Custom'
        ? (s.language_custom || 'English')
        : (s?.language || 'English');
}
/** The native-language name used in AI prompts (e.g. "Korean"). */
export function getNativeLangFromSettings(s) {
    return resolveNativeLang(s?.native_lang ?? 'en', s?.native_lang_custom ?? '');
}
// ── Array utilities ───────────────────────────────────────────────────────────
/** Whether a study-language name is Japanese. */
export const isJapanese = (lang) => /japanese|日本語/i.test(lang);
/** Fisher-Yates shuffle into a new array. Unlike sort(() => Math.random() - 0.5), it is unbiased. */
export function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
// ── Level display helpers ─────────────────────────────────────────────────────
/** CSS class for a level (CEFR, 'grammar', 'sentence' or 'idiom'). */
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
/** Levenshtein edit distance, keeping one row of the table at a time. */
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
export const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー]/u;
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
/**
 * What a message keeps saved per text it has shown (its swipes, edits): the
 * entries for other texts plus `item`, newest last, at most `keep` of them.
 * Entries without a hash (older saves) give way to the new one.
 */
export function withEntryFor(list, item, keep) {
    return [...list.filter(e => e.h && e.h !== item.h), item].slice(-keep);
}
/** A saved value as a list: older saves held one entry, newer ones a list. */
export const entryList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
/**
 * Entries saved by message index, moved to where their messages are now after
 * ST deleted messages and renumbered the rest. `shown` is the text hash each
 * rendered message shows: a message whose text is saved under another index
 * takes that list (its other swipes too), swapping with what was there.
 * Lists left at or past `length` belonged to messages deleted from the end and
 * go; a list a swap moved there stays (it may belong to an older message not
 * rendered yet, found again once it is). Null when nothing changed.
 */
export function relocateEntries(saved, shown, length) {
    const out = { ...saved };
    const has = (k, h) => !!h && entryList(out[k]).some(e => e.h === h);
    /** Keys holding a list a swap moved there. */
    const carried = new Set();
    let changed = false;
    for (const [mesId, h] of [...shown].sort((a, b) => Number(a[0]) - Number(b[0]))) {
        if (has(mesId, h))
            continue;
        // Not from a message that shows its own saved text (two messages can read the same)
        const from = Object.keys(out).find(k => k !== mesId && has(k, h) && !has(k, shown.get(k)));
        if (from === undefined)
            continue;
        const here = out[mesId];
        out[mesId] = out[from];
        carried.delete(mesId);
        if (here === undefined) {
            delete out[from];
            carried.delete(from);
        }
        else {
            out[from] = here;
            carried.add(from);
        }
        changed = true;
    }
    for (const k of Object.keys(out)) {
        if (Number(k) >= length && !carried.has(k)) {
            delete out[k];
            changed = true;
        }
    }
    return changed ? out : null;
}
/** How a study language is stored on entries ("Italian" and " italian" are one language). */
export const langKey = (lang) => lang.trim().toLowerCase();
/** `signal` (when given) and a timeout of `ms` as one signal — without AbortSignal.any, which older Safari lacks. */
export function withTimeout(signal, ms) {
    const timeout = AbortSignal.timeout(ms);
    if (!signal)
        return timeout;
    const both = new AbortController();
    const abort = () => both.abort(signal.aborted ? signal.reason : timeout.reason);
    for (const s of [signal, timeout]) {
        if (s.aborted)
            abort();
        else
            s.addEventListener('abort', abort, { once: true });
    }
    return both.signal;
}
