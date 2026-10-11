// What of a chat message Polyglot studies. Left out:
//   • parts that are not the story (status windows, metadata tags, code
//     blocks, [bracket] lines, JS-Slash-Runner frontends, hidden text):
//     not sent for analysis or furigana, not highlighted;
//   • names (character, user, group members, listed words): never
//     highlighted or saved as vocabulary.
//
// Skipped parts are ranges of the plain text (plain-text.ts), so highlight,
// furigana and dialogue offsets are unchanged; the message hash still covers
// the whole text, so these settings never orphan a saved analysis. ST drops
// unknown tags when rendering (<status> keeps its text), so tag blocks are
// found in the raw message and located in the rendered text by content.
import { getSettings, getContext } from './runtime.js';
import { plainText, plainTextNodes, readableText } from './plain-text.js';
import { dialogueLines, dialogueText } from './dialogue.js';
import { mesIdOf } from './st-dom.js';
import { fieldText } from './deck-import/fields.js';
// ── Lists ─────────────────────────────────────────────────────────────────────
export const parseList = (value) => typeof value === 'string' ? value.split(/[,\n]/).map(s => s.trim()).filter(Boolean) : [];
/** Tag names from the setting; anything that is not a plain tag name is ignored. */
const tagNames = (value) => parseList(value).filter(t => /^[\w:-]+$/.test(t));
const tagBlock = (tags) => new RegExp(`<(${tags.join('|')})\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
// ── Ranges ────────────────────────────────────────────────────────────────────
/** Sorted, with overlapping and touching ranges joined. */
export function mergeRanges(ranges) {
    const out = [];
    for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
        const last = out[out.length - 1];
        if (last && r.start <= last.end)
            last.end = Math.max(last.end, r.end);
        else if (r.end > r.start)
            out.push({ ...r });
    }
    return out;
}
/** The parts of `ranges` outside `cut` (both sorted). */
export function subtractRanges(ranges, cut) {
    const out = [];
    for (const r of ranges) {
        let start = r.start;
        for (const c of cut) {
            if (c.end <= start || c.start >= r.end)
                continue;
            if (c.start > start)
                out.push({ start, end: c.start });
            start = Math.max(start, c.end);
        }
        if (start < r.end)
            out.push({ start, end: r.end });
    }
    return out;
}
/** The text with the ranges blanked out: same length, so offsets still match. */
export const maskRanges = (text, ranges) => ranges.reduce((s, r) => s.slice(0, r.start) + s.slice(r.start, r.end).replace(/[^\n]/g, ' ') + s.slice(r.end), text);
/** What is left of the text, one kept piece per line. */
export const keptText = (text, skipped) => subtractRanges([{ start: 0, end: text.length }], skipped)
    .map(r => text.slice(r.start, r.end).trim())
    .filter(Boolean)
    .join('\n');
// ── Finding skipped parts ─────────────────────────────────────────────────────
/** A text node that is only a bracketed note: [Time: 10:00 | Café] or 【…】. */
const BRACKET_LINE = /^\s*(\[[^[\]\n]*[^\s[\]][^[\]\n]*\]|【[^【】\n]+】)\s*$/;
/** Tag blocks written out as text (ST's "show tags" option). */
export function literalTagRanges(text, tags) {
    if (!tags.length)
        return [];
    return [...text.matchAll(tagBlock(tags))].map(m => ({ start: m.index, end: m.index + m[0].length }));
}
/** Characters that markdown rendering adds or removes; ignored when matching a block to the text. */
const NOISE = /[\s*_~`#>|+=-]/;
function compact(text) {
    let out = '';
    const at = [];
    for (let i = 0; i < text.length; i++) {
        if (NOISE.test(text[i]))
            continue;
        out += text[i];
        at.push(i);
    }
    return { out, at };
}
/**
 * Where a tag block of the raw message (its content: match[2]) shows in the
 * rendered text, or null. Of several places with the same content, the one
 * nearest to where the block stands in the raw message wins (a short status
 * like "Calm" may also be a word of the story).
 */
function locate(plain, raw, m) {
    const needle = compact(fieldText(m[2])).out;
    if (needle.length < 2)
        return null;
    const expected = compact(fieldText(raw.slice(0, m.index))).out.length;
    let best = -1;
    for (let i = plain.out.indexOf(needle); i >= 0; i = plain.out.indexOf(needle, i + 1)) {
        if (best < 0 || Math.abs(i - expected) < Math.abs(best - expected))
            best = i;
    }
    return best < 0 ? null : { start: plain.at[best], end: plain.at[best + needle.length - 1] + 1 };
}
/** Where the blocks of the listed tags show in the rendered text (blocks not found are left in). */
export function blockRanges(text, raw, tags) {
    if (!tags.length)
        return [];
    const plain = compact(text);
    return [...raw.matchAll(tagBlock(tags))].map(m => locate(plain, raw, m)).filter((r) => !!r);
}
/**
 * Elements whose text is skipped. JS-Slash-Runner's frontends (.TH-render)
 * always are: the page shows in an iframe, and the HTML/JS source stays in
 * the message as a hidden code block.
 */
const skipSelector = (s) => ['.TH-render', ...(s.skip_blocks ? ['pre', 'code', 'details'] : [])].join(', ');
/**
 * Tells whether a text node of the message is hidden (display: none) — text
 * a script or regex hid is not what the reader sees. Only while the message
 * itself shows: a message out of view must not count as all hidden.
 */
function hiddenIn(textEl) {
    if (typeof textEl.checkVisibility !== 'function' || !textEl.checkVisibility())
        return () => false;
    const seen = new Map();
    return node => {
        const el = node.parentElement;
        if (!el || el === textEl)
            return false;
        let hidden = seen.get(el);
        if (hidden === undefined)
            seen.set(el, hidden = !el.checkVisibility());
        return hidden;
    };
}
/** The parts of a rendered message's plain text that are not studied. */
export function skippedRanges(textEl) {
    const s = getSettings();
    const selector = skipSelector(s);
    const nodes = plainTextNodes(textEl);
    const hidden = hiddenIn(textEl);
    const ranges = [];
    let offset = 0;
    for (const node of nodes) {
        const start = offset, end = offset + node.data.length;
        offset = end;
        const box = node.parentElement?.closest(selector);
        if ((box && box !== textEl && textEl.contains(box)) || hidden(node) || (s.skip_brackets && BRACKET_LINE.test(node.data))) {
            ranges.push({ start, end });
        }
    }
    const tags = tagNames(s.skip_tags);
    if (tags.length) {
        const text = nodes.map(n => n.data).join('');
        const mesId = mesIdOf(textEl);
        const raw = mesId === null ? undefined : getContext().chat?.[Number(mesId)]?.mes;
        ranges.push(...literalTagRanges(text, tags));
        if (typeof raw === 'string')
            ranges.push(...blockRanges(text, raw, tags));
    }
    return mergeRanges(ranges);
}
/** Text nodes that lie wholly in skipped parts (whitespace aside). */
export function skippedNodes(textEl, ranges = skippedRanges(textEl)) {
    const nodes = new Set();
    if (!ranges.length)
        return nodes;
    let offset = 0;
    for (const node of plainTextNodes(textEl)) {
        const start = offset + (node.data.length - node.data.trimStart().length);
        const end = offset + node.data.trimEnd().length;
        offset += node.data.length;
        if (start < end && ranges.some(r => r.start <= start && r.end >= end))
            nodes.add(node);
    }
    return nodes;
}
/**
 * What 📖 studies in a message: its dialogue lines or its whole text, without
 * skipped parts. Skipped parts are blanked before lines are found, so quotes
 * in a status window are not dialogue.
 */
export function studiedText(textEl, dialogueOnly) {
    const plain = plainText(textEl);
    const skipped = skippedRanges(textEl);
    if (dialogueOnly) {
        const lines = dialogueLines(maskRanges(plain, skipped));
        return { text: dialogueText(plain, lines), plain, skipped, lines };
    }
    return { text: skipped.length ? keptText(plain, skipped) : readableText(textEl), plain, skipped };
}
/** A raw message without its skipped parts (chat history sent for quizzes). */
export function cleanRawMessage(raw, scope) {
    let text = raw;
    const tags = tagNames(scope.skip_tags);
    if (tags.length)
        text = text.replace(tagBlock(tags), '');
    if (scope.skip_blocks) {
        text = text.replace(/```[\s\S]*?```/g, '').replace(/<(pre|details)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    }
    if (scope.skip_brackets) {
        text = text.split('\n').filter(line => !BRACKET_LINE.test(line)).join('\n');
    }
    return text.replace(/\n{3,}/g, '\n\n').trim();
}
// ── Names ─────────────────────────────────────────────────────────────────────
/** How words are compared: case, width and surrounding punctuation ignored, "Anna's" as "Anna". */
export const wordKey = (word) => word.normalize('NFKC').toLowerCase()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .replace(/['’]s$/u, '');
/** Keys of names (each part of a full name too) and of listed words. */
export function skipKeys(names, words) {
    const keys = new Set();
    for (const name of names) {
        keys.add(wordKey(name));
        for (const part of name.split(/[\s\p{P}]+/u))
            if (part.length >= 2)
                keys.add(wordKey(part));
    }
    for (const word of words)
        keys.add(wordKey(word));
    keys.delete('');
    return keys;
}
/**
 * The user's and the character's name; in a group chat, every member's
 * instead of the character's (ST's character name there is not a member's).
 */
function chatNames() {
    const ctx = getContext();
    const names = [ctx.name1];
    if (ctx.groupId) {
        const group = ctx.groups?.find((g) => g.id === ctx.groupId);
        for (const avatar of group?.members ?? [])
            names.push(ctx.characters?.find((c) => c.avatar === avatar)?.name);
    }
    else if (ctx.name2 !== 'SillyTavern System') {
        names.push(ctx.name2);
    }
    return names.filter((n) => typeof n === 'string' && !!n.trim());
}
/** Names and listed words that are not vocabulary, as written (for the analysis prompt). */
export function skippedNames() {
    const s = getSettings();
    const list = [...(s.skip_names ? chatNames() : []), ...parseList(s.skip_words)];
    return [...new Set(list.map(n => n.trim()))].filter(n => n.length <= 40).slice(0, 20);
}
/** Tells whether a found word (or its base form) is a skipped name or word. */
export function wordSkipper() {
    const s = getSettings();
    const keys = skipKeys(s.skip_names ? chatNames() : [], parseList(s.skip_words));
    return (...forms) => keys.size > 0 && forms.some(f => !!f && keys.has(wordKey(f)));
}
