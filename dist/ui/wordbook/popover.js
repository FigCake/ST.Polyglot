// ════════════════════════════
// Polyglot  ui/wordbook/popover.ts
// ════════════════════════════
// Small popover showing a word's original form and its meaning in context.
import { html, setHtml } from '../../html.js';
const EDGE = 8;
let current = null;
let outsideClickBound = false;
export function hidePopover() {
    current?.el.remove();
    current = null;
}
/** Shows the popover under `anchor`, or hides it if it is already open there. */
export function togglePopover(anchor, originalForm, contextMeaning) {
    if (current?.anchor === anchor) {
        hidePopover();
        return;
    }
    hidePopover();
    const el = Object.assign(document.createElement('div'), { className: 'pg-wb-popover' });
    setHtml(el, html `
        <div class="pg-wb-popover-word">${originalForm}</div>
        <div class="pg-wb-popover-meaning">${contextMeaning}</div>`);
    document.body.appendChild(el);
    current = { el, anchor };
    // Below the anchor, flipped above / pulled inside when it would leave the viewport
    const rect = anchor.getBoundingClientRect();
    const w = el.offsetWidth || 200, h = el.offsetHeight || 60;
    let left = Math.min(rect.left, innerWidth - w - EDGE);
    let top = rect.bottom + 4;
    if (top + h > innerHeight - EDGE)
        top = rect.top - h - 4;
    left = Math.max(4, left);
    top = Math.max(4, top);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    requestAnimationFrame(() => el.classList.add('pg-wb-popover-visible'));
    if (!outsideClickBound) {
        outsideClickBound = true;
        document.addEventListener('click', e => {
            if (current && !current.el.contains(e.target) && e.target !== current.anchor)
                hidePopover();
        });
    }
}
