// ════════════════════════════
// Polyglot  ui/tap/lookup.ts
// ════════════════════════════
// Select text in a message → a small tooltip:
//
//   mouse   [Look up]                          (double-click translates instead)
//   touch   [Look up] [Translate sentence]     (touch has no double-click)
//
// Look up shows the word in the Learn tab; Translate is handed to tap-translate.
//
// Dependencies: constants.ts, html.ts, i18n.ts, plain-text.ts, ui/learning-panel.ts, ui/tap/sentence.ts
import { DELAY } from '../../constants.js';
import { html, setHtml } from '../../html.js';
import { t } from '../../i18n.js';
import { lookUpWord } from '../learning-panel.js';
import { messageTextOf, sentenceAround } from './sentence.js';
import { plainText, plainOffsetIn, selectionText } from '../../plain-text.js';
const MAX_SELECTION = 200;
const TOOLTIP_OFFSET = { above: 44, below: 8, margin: 4 };
let tooltip = null;
export function removeSelectionTooltip() {
    tooltip?.remove();
    tooltip = null;
}
/** The sentence around the selection, for context-aware meanings. */
function selectionContext(sel) {
    const range = sel.getRangeAt(0);
    const textEl = messageTextOf(range.startContainer);
    if (!textEl)
        return '';
    const full = plainText(textEl);
    const text = selectionText(sel).trim();
    // Locate the exact occurrence the user dragged, not just the first match
    let start = plainOffsetIn(textEl, range.startContainer, range.startOffset);
    if (start < 0)
        start = full.indexOf(text);
    return start < 0 ? full.slice(0, MAX_SELECTION) : sentenceAround(full, start, start + text.length);
}
/** Centres the tooltip over the selection; below it for touch (the native menu sits above) or near the top edge. */
function place(el, rect, touch) {
    const width = el.offsetWidth;
    const centre = rect.left + scrollX + rect.width / 2;
    el.style.left = `${Math.max(TOOLTIP_OFFSET.margin + scrollX, Math.min(centre - width / 2, scrollX + innerWidth - width - TOOLTIP_OFFSET.margin))}px`;
    const above = rect.top + scrollY - TOOLTIP_OFFSET.above;
    const below = rect.bottom + scrollY + TOOLTIP_OFFSET.below;
    el.style.top = `${touch || above < scrollY + TOOLTIP_OFFSET.margin ? below : above}px`;
}
function showTooltip(sel, touch, actions) {
    const word = selectionText(sel).trim();
    const context = selectionContext(sel);
    const range = sel.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    removeSelectionTooltip();
    tooltip = Object.assign(document.createElement('div'), { className: 'pg-sel-tooltip' });
    setHtml(tooltip, html `
        <button class="pg-sel-btn" data-sel="lookup"><i class="fa-solid fa-magnifying-glass"></i> ${t('tap.lookUp')}</button>
        ${touch && actions.canTranslate(range) && html `
        <button class="pg-sel-btn" data-sel="translate"><i class="fa-solid fa-language"></i> ${t('tap.translate')}</button>`}`);
    tooltip.addEventListener('click', e => {
        const action = e.target.closest('[data-sel]')?.dataset.sel;
        if (!action)
            return;
        e.stopPropagation();
        removeSelectionTooltip();
        getSelection()?.removeAllRanges();
        if (action === 'translate')
            actions.translate(range);
        else
            lookUpWord(word, context);
    });
    document.body.appendChild(tooltip);
    const el = tooltip;
    requestAnimationFrame(() => place(el, rect, touch));
}
/** Shows the tooltip after a selection inside the chat; hides it on new interactions and scrolling. */
export function setupTextSelectionTooltip(actions) {
    const onSelectionEnd = (e) => {
        if (tooltip?.contains(e.target))
            return;
        if (!document.getElementById('chat')?.contains(e.target)) {
            removeSelectionTooltip();
            return;
        }
        // Mobile browsers finalise the selection range slightly after touchend
        setTimeout(() => {
            const sel = getSelection();
            const text = sel ? selectionText(sel).trim() : '';
            if (!sel?.rangeCount || !text || text.length > MAX_SELECTION) {
                removeSelectionTooltip();
                return;
            }
            showTooltip(sel, e.type === 'touchend', actions);
        }, DELAY.tooltipShow);
    };
    const onSelectionStart = (e) => {
        if (tooltip && !tooltip.contains(e.target))
            removeSelectionTooltip();
    };
    document.addEventListener('mouseup', onSelectionEnd);
    document.addEventListener('mousedown', onSelectionStart);
    document.addEventListener('touchend', onSelectionEnd, { passive: true });
    document.addEventListener('touchstart', onSelectionStart, { passive: true });
    // #chat may not exist yet at startup
    let scrollBound = false;
    const bindScroll = () => {
        const chat = document.getElementById('chat');
        if (!chat || scrollBound)
            return;
        chat.addEventListener('scroll', removeSelectionTooltip, { passive: true });
        scrollBound = true;
    };
    bindScroll();
    setTimeout(bindScroll, DELAY.menuReattach);
}
