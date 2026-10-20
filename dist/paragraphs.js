// Where the paragraphs of a rendered message are: a block of it (<p>, <li>, a
// <div> of text) or text between blank lines, read in order, with the place
// right after each one (para-translate.ts puts translations there). Parts the
// caller skips (study-scope.ts) and what Polyglot added are left out.
import { notMessageText, BLOCK_TAGS, BLOCK_SELECTOR } from './plain-text.js';
import { textHash } from './furigana/model.js';
/** Blocks that are not prose to translate. */
const NOT_PROSE = new Set(['PRE', 'TABLE', 'HR', 'SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'svg']);
/** Blocks a translation goes after rather than inside (a <div> may not sit in a <p>). */
const AFTER = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DT', 'SUMMARY']);
/** The text of some nodes as read, line breaks kept, without skipped parts. */
function textOf(nodes, skipped) {
    let out = '';
    const visit = (n) => {
        if (n instanceof Text) {
            if (!skipped.has(n))
                out += n.data;
            return;
        }
        if (!(n instanceof Element) || notMessageText(n))
            return;
        if (n.tagName === 'BR') {
            out += '\n';
            return;
        }
        n.childNodes.forEach(visit);
    };
    nodes.forEach(visit);
    return out.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').trim();
}
const isBreak = (n) => n instanceof Element && n.tagName === 'BR';
const isBlank = (n) => n instanceof Text && !n.data.trim();
/** The next sibling that is not blank text. */
function nextReal(n) {
    let next = n.nextSibling;
    while (next && isBlank(next))
        next = next.nextSibling;
    return next;
}
/** The paragraphs of a rendered message, in reading order. */
export function paragraphsOf(textEl, skipped = new Set()) {
    const out = [];
    const walk = (container) => {
        // This container's own runs of text, finished once the container has been read through
        const mine = [];
        let run = [];
        let hasBlocks = false;
        const flush = () => {
            const text = run.length ? textOf(run, skipped) : '';
            if (text) {
                const paragraph = { text, key: textHash(text), place: () => { } };
                mine.push({ paragraph, nodes: run });
                out.push(paragraph);
            }
            run = [];
        };
        for (const child of [...container.childNodes]) {
            if (child instanceof Element) {
                if (notMessageText(child) || NOT_PROSE.has(child.tagName)) {
                    flush();
                    continue;
                }
                // A block, or an inline wrapper around blocks (<font><p>…</p></font>), is read inside
                if (BLOCK_TAGS.has(child.tagName) || child.querySelector(BLOCK_SELECTOR)) {
                    flush();
                    hasBlocks = true;
                    walk(child);
                    continue;
                }
                // A blank line (two breaks) ends a paragraph
                if (isBreak(child) && isBreak(nextReal(child))) {
                    flush();
                    continue;
                }
            }
            run.push(child);
        }
        flush();
        // A <p> that is one paragraph gets its translation after it; otherwise after the paragraph's last text
        const whole = mine.length === 1 && !hasBlocks && container !== textEl && AFTER.has(container.tagName);
        for (const { paragraph, nodes } of mine) {
            const last = [...nodes].reverse().find(n => !isBreak(n) && !isBlank(n)) ?? nodes[nodes.length - 1];
            paragraph.place = el => { if (whole)
                container.after(el);
            else
                last.parentNode?.insertBefore(el, last.nextSibling); };
        }
    };
    walk(textEl);
    return out;
}
