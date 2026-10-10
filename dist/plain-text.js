// ════════════════════════════
// Polyglot  plain-text.ts
// ════════════════════════════
// The text a reader sees in a message, without what Polyglot added to it:
// furigana readings (<rt>, <rp>) and translation bubbles. Every feature that
// reads message text — tap translation, look-up, annotation, furigana —
// goes through here, so a ruby reading never leaks into a prompt or the
// clipboard.
//
// Dependencies: none (DOM only)
/** Elements whose text is not part of the message's own text. */
const NOT_TEXT = new Set(['SCRIPT', 'STYLE', 'RT', 'RP']);
const ADDED = '.pg-tap-bubble';
/** Text nodes of the message's own text, in document order. */
export function plainTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: n => n instanceof Element && (NOT_TEXT.has(n.tagName) || n.matches(ADDED))
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
    if (!host?.closest('ruby') && !host?.querySelector('ruby, .pg-tap-bubble'))
        return sel.toString();
    return fragmentText(range.cloneContents());
}
/** The readable text of a message element (line breaks kept), without readings. */
export function readableText(el) {
    if (!el.querySelector('ruby, .pg-tap-bubble'))
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
        if (!host?.closest('#chat') || (!host.closest('ruby') && !host.querySelector('ruby')))
            return;
        e.clipboardData.setData('text/plain', selectionText(sel));
        e.preventDefault();
    });
}
