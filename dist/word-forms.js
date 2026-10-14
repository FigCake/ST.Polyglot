// Finding saved words in a message without asking the AI. Each word brings
// the forms already stored with it; a message is matched against all of them
// at once (a lookup per token, not a search per word), so thousands of words
// cost about the same as a few.
//
//   formsOf(entry, conj)   word, base form, the form it was saved from, the form in
//                          its example, the Japanese reading, forms seen in analyses,
//                          and its conjugation table when one was opened
//   new FormIndex(words)   the forms of many words, ready to match
//   index.find(text)       where saved words stand in the text, longest first,
//                          never overlapping
//
// Scripts with spaces are split into tokens ("l'amico" also tries "amico");
// Korean tries the token without one to three trailing letters (particles:
// 학교에서 → 학교); Japanese and Chinese are searched character by character,
// longest form first, and one-character forms are left out (本 would light up
// in 日本). Phrases (forms with spaces) are searched as wholes. No guessing
// beyond stored forms: a form never seen is not found.
//
// Pure: no DOM, no I/O.
import { UNSPACED, findWord } from './utils.js';
/** Forms of a word kept from analyses (the surface forms it was met in). */
export const FORMS_KEPT = 8;
const norm = (s) => s.normalize('NFKC').toLowerCase().trim();
const HANGUL = /\p{Script=Hangul}/u;
/** Trailing letters a Korean token may carry after the word (particles, endings). */
const KOREAN_TAIL = 3;
/** The longest piece of a conjugation table cell: "ho parlato" → "parlato", "fange an" → "fange". */
function mainToken(form) {
    const parts = form.split(/\s+/).filter(Boolean);
    return parts.reduce((a, b) => (b.length > a.length ? b : a), '');
}
/** Every form a word can be found by (normalised, duplicates removed). */
export function formsOf(e, conj) {
    const forms = [e.word, e.base_form, e.original_form, e.example_form, e.reading, ...(e.forms ?? [])];
    for (const tense of conj?.tenses ?? [])
        for (const row of tense.rows ?? [])
            if (typeof row?.form === 'string')
                forms.push(mainToken(row.form));
    return [...new Set(forms.filter((f) => typeof f === 'string').map(norm).filter(f => f.length > 0))];
}
export class FormIndex {
    /** Single-token forms of spaced scripts → word. */
    tokens = new Map();
    /** Forms in Japanese / Chinese (…) script by first character, longest first. */
    unspaced = new Map();
    /** Forms with spaces. */
    phrases = [];
    /** Every form → word, for lookups of one form. */
    all = new Map();
    constructor(words) {
        for (const { word, forms } of words) {
            for (const form of forms) {
                if (!this.all.has(form))
                    this.all.set(form, word);
                if (UNSPACED.test(form)) {
                    if ([...form].length < 2)
                        continue;
                    const list = this.unspaced.get(form[0]) ?? [];
                    list.push({ form, word });
                    this.unspaced.set(form[0], list);
                }
                else if (/\s/.test(form)) {
                    this.phrases.push({ form, word });
                }
                else if (!this.tokens.has(form)) {
                    this.tokens.set(form, word);
                }
            }
        }
        for (const list of this.unspaced.values())
            list.sort((a, b) => b.form.length - a.form.length);
    }
    /** The word a single form belongs to (any script, the form as a whole), if any. */
    wordOf(form) {
        return form ? this.all.get(norm(form)) : undefined;
    }
    get size() {
        return this.tokens.size + this.phrases.length + [...this.unspaced.values()].reduce((n, l) => n + l.length, 0);
    }
    find(text) {
        const lower = text.toLowerCase();
        // Positions are counted in the lowercased text: a letter whose lowercase is longer (İ) would shift them
        if (lower.length !== text.length)
            return [];
        const found = [];
        // Phrases, as wholes
        for (const { form, word } of this.phrases) {
            for (let at = findWord(lower, form); at !== -1; at = findWord(lower, form, at + form.length)) {
                found.push({ start: at, end: at + form.length, word });
            }
        }
        // Tokens of spaced scripts (letters, digits, marks, joined by apostrophes)
        for (const m of lower.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu)) {
            const token = m[0], start = m.index;
            if (UNSPACED.test(token))
                continue;
            const hit = this.tokenHit(token);
            if (hit)
                found.push({ start: start + hit.offset, end: start + hit.offset + hit.length, word: hit.word });
        }
        // Japanese, Chinese (…): longest form starting at each character
        if (this.unspaced.size) {
            for (let i = 0; i < lower.length; i++) {
                const list = this.unspaced.get(lower[i]);
                if (!list)
                    continue;
                const hit = list.find(c => lower.startsWith(c.form, i));
                if (hit) {
                    found.push({ start: i, end: i + hit.form.length, word: hit.word });
                    i += hit.form.length - 1;
                }
            }
        }
        // Longest first where they overlap
        found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
        const kept = [];
        for (const m of found)
            if (!kept.length || m.start >= kept[kept.length - 1].end)
                kept.push(m);
        return kept;
    }
    /** A token's match: the whole token, a piece around an apostrophe, or a Korean word before its particle. */
    tokenHit(token) {
        const whole = this.tokens.get(token);
        if (whole)
            return { offset: 0, length: token.length, word: whole };
        const quote = token.search(/['’][^'’]*$/);
        if (quote > 0) {
            const after = token.slice(quote + 1), before = token.slice(0, quote);
            const a = this.tokens.get(after);
            if (a)
                return { offset: quote + 1, length: after.length, word: a };
            const b = this.tokens.get(before);
            if (b)
                return { offset: 0, length: before.length, word: b };
        }
        if (HANGUL.test(token)) {
            const chars = [...token];
            for (let cut = 1; cut <= KOREAN_TAIL && chars.length - cut >= 2; cut++) {
                const stem = chars.slice(0, chars.length - cut).join('');
                const w = this.tokens.get(stem);
                if (w)
                    return { offset: 0, length: stem.length, word: w };
            }
        }
        return null;
    }
}
/** `forms` with `seen` added (when new), the newest kept last, at most FORMS_KEPT. */
export function withSeenForm(forms, seen) {
    const form = norm(seen);
    const list = forms ?? [];
    if (!form || list.map(norm).includes(form))
        return [...list];
    return [...list, seen.trim()].slice(-FORMS_KEPT);
}
