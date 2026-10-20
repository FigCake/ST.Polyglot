// The text a reader sees in a message, without what Polyglot added to it:
// furigana readings (<rt>, <rp>), translation bubbles and paragraph
// translations. Every feature that reads message text — tap translation,
// look-up, annotation, furigana — goes through here, so a ruby reading or a
// translation never leaks into a prompt or the clipboard.
import { ST_SEL, mesIdOf } from './st-dom.js';
import { textHash } from './furigana/model.js';
/** Elements whose text is not part of the message's own text. */
const NOT_TEXT = new Set(['SCRIPT', 'STYLE', 'RT', 'RP']);
/** What Polyglot adds inside a message: the tap bubble and the paragraph translations (para-translate.ts). */
export const ADDED = '.pg-tap-bubble, .pg-para-trans';
/** Whether an element holds no text of the message's own (a reading, a translation Polyglot added). */
export const notMessageText = (el) => NOT_TEXT.has(el.tagName) || el.matches(ADDED);
/** Text nodes of the message's own text, in document order. */
export function plainTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: n => n instanceof Element && notMessageText(n)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode())
        if (n instanceof Text)
            nodes.push(n);
    return nodes;
}
/** The concatenated plain text (offsets in it match plainOffsetIn). */
export const plainText = (root) => plainTextNodes(root).map(n => n.data).join('');
/** Elements that start a block of their own on the page (paragraphs, lists, tables…). */
export const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'PRE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER',
    'MAIN', 'NAV', 'CENTER', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'HR',
]);
export const BLOCK_SELECTOR = [...BLOCK_TAGS].map(tag => tag.toLowerCase()).join(', ');
/**
 * Plain-text offsets where a paragraph begins on the page: the first text of
 * each block element (<p>, <div>, <li>…) and the text after a <br>. The plain
 * text has no line break there when ST renders paragraphs as elements.
 */
export function blockStarts(root) {
    const starts = new Set([0]);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: n => n instanceof Element && notMessageText(n)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
    });
    let offset = 0, block, afterBreak = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n instanceof Element) {
            if (n.tagName === 'BR')
                afterBreak = true;
            continue;
        }
        if (!(n instanceof Text))
            continue;
        const own = n.parentElement?.closest(BLOCK_SELECTOR) ?? null;
        if (afterBreak || (block !== undefined && own !== block))
            starts.add(offset);
        afterBreak = false;
        block = own;
        offset += n.data.length;
    }
    return starts;
}
/** The text hash of every rendered message, by message index. */
export function shownTextHashes() {
    const out = new Map();
    for (const el of document.querySelectorAll(`${ST_SEL.mes} ${ST_SEL.mesText}`)) {
        const mesId = mesIdOf(el);
        if (mesId !== null)
            out.set(mesId, textHash(plainText(el)));
    }
    return out;
}
/**
 * Offset of a DOM position within plainText(root); -1 if outside root.
 * A position inside a reading counts as the start of the next plain text.
 */
export function plainOffsetIn(root, node, offset) {
    if (!root.contains(node))
        return -1;
    let total = 0;
    for (const text of plainTextNodes(root)) {
        if (text === node)
            return total + offset;
        // `node` lies before this text node (e.g. inside an <rt>): stop here
        if (node.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)
            return total;
        total += text.data.length;
    }
    return total;
}
/** Text of a DOM fragment with readings and added elements removed. */
function fragmentText(fragment) {
    fragment.querySelectorAll(`rt, rp, ${ADDED}`).forEach(el => el.remove());
    return fragment.textContent ?? '';
}
/** The selected text without furigana readings. */
export function selectionText(sel) {
    if (!sel.rangeCount)
        return '';
    const range = sel.getRangeAt(0);
    const host = range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    // Plain selections keep the browser's own text (line breaks between paragraphs)
    if (!host?.closest('ruby') && !host?.querySelector(`ruby, ${ADDED}`))
        return sel.toString();
    return fragmentText(range.cloneContents());
}
/** The readable text of a message element (line breaks kept), without readings. */
export function readableText(el) {
    if (!el.querySelector(`ruby, ${ADDED}`))
        return el.innerText;
    const copy = el.cloneNode(true);
    copy.querySelectorAll(`rt, rp, ${ADDED}`).forEach(e => e.remove());
    // Keep paragraph breaks that innerText would have produced
    copy.querySelectorAll('p, br, div, li').forEach(e => e.append('\n'));
    return (copy.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
/** Copying from a message copies the text without readings. */
export function setupPlainCopy() {
    document.addEventListener('copy', e => {
        const sel = getSelection();
        if (!sel?.rangeCount || !e.clipboardData)
            return;
        const range = sel.getRangeAt(0);
        const host = range.commonAncestorContainer instanceof Element
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        if (!host?.closest(ST_SEL.chat) || (!host.closest('ruby') && !host.querySelector('ruby')))
            return;
        e.clipboardData.setData('text/plain', selectionText(sel));
        e.preventDefault();
    });
}
