// ════════════════════════════
// Polyglot  ui/tap-translate.ts
// ════════════════════════════
// Tap-to-translate, text-selection tooltip, and quick-lookup bubble.
//
// Design rules:
//   • All ST state and index.ts functions are injected via TapDeps.
//   • No direct imports from index.ts.
//
// Dependencies: constants.ts, types.ts, prompts.ts, utils.ts,
//               ui.manager.ts, conj-cache.ts, features/conjugation.ts
import { DELAY, API } from '../constants.js';
import { quickLookupPrompt, tapTranslatePrompt, deepAnalysisPrompt } from '../prompts.js';
import { parseJSON } from '../utils.js';
import { escapeHtml } from '../ui.manager.js';
import { getConjCache } from '../conj-cache.js';
import { t } from '../i18n.js';
import { showConjugationPopup } from '../features/conjugation.js';
// ── Injected deps ─────────────────────────────────────────────────────────────
let _deps = null;
export function initTapTranslate(deps) {
    _deps = deps;
}
let _selTooltip = null;
let _lookupAbort = null;
function removeSelTooltip() { if (_selTooltip) {
    _selTooltip.remove();
    _selTooltip = null;
} }
function extractContextSentence(sel) {
    if (!sel?.rangeCount)
        return '';
    const range = sel.getRangeAt(0);
    // Walk up from the anchor node to find the .mes_text container
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE)
        node = node.parentNode;
    while (node && node !== document.body) {
        if (node.classList?.contains('mes_text'))
            break;
        node = node.parentNode;
    }
    if (!node || node === document.body)
        return '';
    const container = node;
    // Compute the character offset of the selection start within the container's
    // full text content, using a TreeWalker instead of indexOf so duplicate words
    // are resolved to the exact occurrence the user dragged.
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let charOffset = 0;
    let selStart = -1;
    const startNode = range.startContainer;
    while (walker.nextNode()) {
        const tn = walker.currentNode;
        if (tn === startNode) {
            selStart = charOffset + range.startOffset;
            break;
        }
        charOffset += tn.length;
    }
    const full = container.textContent || '';
    const idx = selStart >= 0 ? selStart : full.indexOf(sel.toString().trim());
    if (idx === -1)
        return full.slice(0, 200);
    const enders = /[.!?。！？\n]/;
    let s = idx;
    while (s > 0 && !enders.test(full[s - 1]))
        s--;
    let e = idx + sel.toString().trim().length;
    while (e < full.length && !enders.test(full[e]))
        e++;
    return full.slice(s, e < full.length ? e + 1 : e).trim();
}
export function setupTextSelectionTooltip() {
    // Unified handler for both mouse and touch selection end
    const handleSelectionEnd = (ev) => {
        if (_selTooltip?.contains(ev.target))
            return;
        const chat = document.getElementById('chat');
        if (!chat?.contains(ev.target)) {
            removeSelTooltip();
            return;
        }
        // 50ms delay: mobile browsers need extra time to finalise the selection range
        setTimeout(() => {
            const sel = window.getSelection();
            const text = sel?.toString().trim() ?? '';
            if (!text || text.length > 200 || !sel?.rangeCount) {
                removeSelTooltip();
                return;
            }
            const range = sel.getRangeAt(0);
            const word = text;
            const context = extractContextSentence(sel);
            removeSelTooltip();
            const rect = range.getBoundingClientRect();
            _selTooltip = document.createElement('div');
            _selTooltip.className = 'pg-sel-tooltip';
            _selTooltip.innerHTML = `<button class="pg-sel-btn"><i class="fa-solid fa-magnifying-glass"></i> ${t('tap.lookUp')}</button>`;
            document.body.appendChild(_selTooltip);
            requestAnimationFrame(() => {
                if (!_selTooltip)
                    return;
                const tw = _selTooltip.offsetWidth;
                const cx = rect.left + scrollX + rect.width / 2;
                const left = Math.max(4 + scrollX, Math.min(cx - tw / 2, scrollX + innerWidth - tw - 4));
                _selTooltip.style.left = left + 'px';
                // On mobile (pointer: coarse) or when there's no room above,
                // place tooltip below to avoid clashing with native copy/paste popup
                const aboveY = rect.top + scrollY - 44;
                const belowY = rect.bottom + scrollY + 8;
                const isMobile = window.matchMedia('(pointer: coarse)').matches;
                _selTooltip.style.top = (isMobile || aboveY < scrollY + 4)
                    ? belowY + 'px'
                    : aboveY + 'px';
            });
            _selTooltip.querySelector('.pg-sel-btn')?.addEventListener('click', async (ev2) => {
                ev2.stopPropagation();
                removeSelTooltip();
                window.getSelection()?.removeAllRanges();
                await runQuickLookup(word, context);
            });
        }, DELAY.tooltipShow);
    };
    // Unified handler for both mouse and touch selection start (dismiss tooltip)
    const handleSelectionStart = (ev) => {
        if (_selTooltip && !_selTooltip.contains(ev.target))
            removeSelTooltip();
    };
    // Desktop mouse events
    document.addEventListener('mouseup', handleSelectionEnd);
    document.addEventListener('mousedown', handleSelectionStart);
    // Mobile touch events
    document.addEventListener('touchend', handleSelectionEnd, { passive: true });
    document.addEventListener('touchstart', handleSelectionStart, { passive: true });
    let _scrollAttached = false;
    const attach = () => {
        const chat = document.getElementById('chat');
        if (chat && !_scrollAttached) {
            chat.addEventListener('scroll', removeSelTooltip, { passive: true });
            _scrollAttached = true;
        }
    };
    attach();
    setTimeout(attach, DELAY.menuReattach);
}
export async function runQuickLookup(word, context) {
    // Guard: initTapTranslate() may not have been called yet (e.g. /pg-lookup slash
    // command fired before APP_READY, or a test environment without full init).
    if (!_deps)
        return;
    if (_lookupAbort)
        _lookupAbort.abort();
    _lookupAbort = new AbortController();
    const { signal } = _lookupAbort;
    _deps?.openLearningPanel('learn', { type: 'loading', word });
    try {
        const result = parseJSON(await _deps?.callModel(API.sysJson, quickLookupPrompt(word, context, _deps?.getLang() ?? 'English', _deps?.getSettings().cefr_level, _deps?.getNativeLang() ?? 'en'), signal));
        if (signal.aborted)
            return;
        result.level = result.level || 'B1';
        _deps?.openLearningPanel('learn', { type: 'word', data: result });
    }
    catch (e) {
        if (signal.aborted)
            return;
        _deps?.openLearningPanel('learn', { type: 'error', word, message: e instanceof Error ? e.message : String(e) });
    }
    finally {
        _lookupAbort = null;
    }
}
// ════════════════════════════
// Tap-to-Translate (double-click / long-tap → inline translation bubble)
// ════════════════════════════
// Active translation request controllers, keyed by mesId
const _tapTransAborts = new Map();
/** Removes open translation bubbles, optionally scoped to a specific mesId. */
export function removeTapBubbles(mesId = null) {
    if (mesId) {
        document.querySelectorAll(`.mes[mesid="${CSS.escape(mesId)}"] .pg-tap-bubble`)
            .forEach(b => b.remove());
    }
    else {
        document.querySelectorAll('.pg-tap-bubble').forEach(b => b.remove());
    }
}
/**
 * Extracts the sentence at a given text-node offset.
 * Similar to extractContextSentence but operates on a caret position, not a Selection.
 */
function _sentenceAtCaret(node, offset) {
    // Find the actual text container at the click point
    const el = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    // Walk up to find mes_text
    let mesTextEl = el;
    while (mesTextEl && mesTextEl !== document.body) {
        if (mesTextEl.classList?.contains('mes_text'))
            break;
        mesTextEl = mesTextEl.parentNode;
    }
    if (!mesTextEl || mesTextEl === document.body)
        return null;
    const mesTextHTMLEl = mesTextEl;
    // Walk up to the direct child of mes_text (bubble insertion point)
    let anchorNode = el;
    while (anchorNode && anchorNode.parentNode !== mesTextHTMLEl) {
        anchorNode = anchorNode.parentNode;
    }
    // If anchorEl is mes_text itself, return null (caller uses appendChild fallback)
    const anchorEl = (anchorNode && anchorNode !== mesTextHTMLEl)
        ? anchorNode
        : null;
    const full = mesTextHTMLEl.textContent || '';
    if (!full.trim())
        return null;
    // Convert the click offset to an absolute position within the full text
    let absOffset = 0;
    const walker = document.createTreeWalker(mesTextHTMLEl, NodeFilter.SHOW_TEXT);
    let cur;
    while ((cur = walker.nextNode())) {
        if (cur === node) {
            absOffset += offset;
            break;
        }
        absOffset += cur.textContent.length;
    }
    // Detect sentence boundaries
    const enders = /[.!?。！？\n]/;
    let s = absOffset;
    while (s > 0 && !enders.test(full[s - 1]))
        s--;
    let e = absOffset;
    while (e < full.length && !enders.test(full[e]))
        e++;
    const sentence = full.slice(s, e < full.length ? e + 1 : e).trim();
    return sentence.length >= 3 ? { sentence, textEl: mesTextHTMLEl, anchorEl } : null;
}
/** Inserts the translation bubble immediately after the clicked paragraph. */
function _showTapBubble(textEl, anchorEl, sentence, state) {
    // Toggle off if a bubble for the same sentence is already open
    const existing = textEl.querySelector('.pg-tap-bubble');
    if (existing) {
        const prev = existing.dataset.sentence;
        // Abort any in-flight deep analysis before removing the bubble
        existing._deepAbort?.abort();
        existing.remove();
        if (prev === sentence)
            return false; // same sentence — just close
    }
    const bubble = document.createElement('div');
    bubble.className = 'pg-tap-bubble';
    bubble.dataset.sentence = sentence;
    if (state === 'loading') {
        bubble.innerHTML = `
            <div class="pg-tap-bubble-inner pg-tap-loading">
                <div class="pg-skeleton" style="height:12px;width:55%;border-radius:6px;margin-bottom:7px;"></div>
                <div class="pg-skeleton" style="height:9px;width:80%;border-radius:5px;margin-bottom:5px;"></div>
                <div class="pg-skeleton" style="height:9px;width:65%;border-radius:5px;"></div>
            </div>`;
    }
    else if (state.error) {
        bubble.innerHTML = `
            <div class="pg-tap-bubble-inner pg-tap-error">
                <span>${t('tap.failed', { msg: escapeHtml(state.error) })}</span>
            </div>`;
    }
    else {
        const { translation, literal, key_verbs = [] } = state;
        const verbsHtml = key_verbs.length ? `
            <div class="pg-tap-verbs">
                ${key_verbs.map(v => `<span class="pg-tap-verb-chip">
                        <b>${escapeHtml(v.form)}</b>
                        <span class="pg-tap-verb-arrow">→</span>
                        ${escapeHtml(v.base)}
                        <span class="pg-tap-verb-meaning">${escapeHtml(v.meaning)}</span>
                        <button class="pg-tap-conj-btn" data-base="${escapeHtml(v.base)}" title="${t('wb.conjTable')}">📊</button>
                        <button class="pg-tap-save-btn" data-word="${escapeHtml(v.form)}" data-base="${escapeHtml(v.base)}" data-meaning="${escapeHtml(v.meaning)}" data-level="${escapeHtml(v.level || '')}" title="${t('wb.addWord')}">＋</button>
                    </span>`).join('')}
            </div>` : '';
        bubble.innerHTML = `
            <div class="pg-tap-bubble-inner">
                <div class="pg-tap-translation">${escapeHtml(translation)}</div>
                ${literal && literal !== translation
            ? `<div class="pg-tap-literal">${escapeHtml(literal)}</div>` : ''}
                ${verbsHtml}
                <div class="pg-tap-actions">
                    <button class="pg-tap-deep" title="${t('tap.deepTitle')}">${t('tap.deep')}</button>
                    <button class="pg-tap-save-sentence" title="${t('tap.saveSentenceTitle')}">${t('tap.saveSentence')}</button>
                    <button class="pg-tap-close" title="${t('tap.close')}"></button>
                </div>
            </div>`;
        bubble.querySelector('.pg-tap-close')?.addEventListener('click', e => {
            e.stopPropagation();
            // Abort any in-flight deep analysis for this bubble
            bubble._deepAbort?.abort();
            bubble.remove();
        });
        // 📊 Conjugation buttons — one per key verb base form
        bubble.querySelectorAll('.pg-tap-conj-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                showConjugationPopup(btn.dataset.base ?? '', _deps?.getLang() ?? 'English', { callModel: _deps.callModel.bind(_deps), getLang: _deps.getLang.bind(_deps), getNativeLang: _deps.getNativeLang.bind(_deps) });
            });
        });
        // + Save individual verb to wordbook (include cached conjugation table if already loaded)
        bubble.querySelectorAll('.pg-tap-save-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const typedBtn = btn;
                const base = typedBtn.dataset.base ?? typedBtn.dataset.word ?? '';
                // Include conjugation table from IDB cache if present (undefined is ignored)
                const cached = await getConjCache(base, _deps?.getLang() ?? 'English').catch(() => null);
                _deps?.addToWordbook({
                    word: typedBtn.dataset.word ?? '',
                    base_form: base,
                    meaning: typedBtn.dataset.meaning ?? '',
                    level: typedBtn.dataset.level || '',
                    conj_cache: cached ?? undefined,
                });
                btn.textContent = t('tap.saved');
                typedBtn.disabled = true;
            });
        });
        // 📖 Save sentence as a wordbook entry
        bubble.querySelector('.pg-tap-save-sentence')?.addEventListener('click', e => {
            e.stopPropagation();
            _deps?.addToWordbook({
                word: sentence.trim().slice(0, 80),
                base_form: '',
                meaning: translation,
                level: 'sentence',
            });
            const btn = bubble.querySelector('.pg-tap-save-sentence');
            if (btn) {
                btn.textContent = t('wb.saved');
                btn.disabled = true;
            }
        });
        // 🔍 Deep Analysis button
        bubble.querySelector('.pg-tap-deep')?.addEventListener('click', e => {
            e.stopPropagation();
            const deepBtn = e.currentTarget;
            // Prevent double-tap while loading
            if (deepBtn.dataset.loading === 'true')
                return;
            _runDeepAnalysis(sentence, bubble, deepBtn);
        });
    }
    // Insert after anchorEl (direct child of mes_text) or append at the end
    if (anchorEl && anchorEl.parentNode === textEl) {
        anchorEl.insertAdjacentElement('afterend', bubble);
    }
    else {
        textEl.appendChild(bubble);
    }
    return true;
}
// ── Deep Analysis ─────────────────────────────────────────────────────────────
/** Role → accent-colour CSS class mapping for syntax token chips. */
const _ROLE_CLASS = {
    subject: 'pg-deep-role-subj',
    verb: 'pg-deep-role-verb',
    auxiliary: 'pg-deep-role-verb',
    object: 'pg-deep-role-obj',
    complement: 'pg-deep-role-comp',
    modifier: 'pg-deep-role-mod',
    conjunction: 'pg-deep-role-conj',
    particle: 'pg-deep-role-part',
    article: 'pg-deep-role-art',
    preposition: 'pg-deep-role-prep',
    pronoun: 'pg-deep-role-pron',
};
/**
 * Fires the deep-analysis API call for `sentence`, then renders the result
 * into the existing translation bubble.
 * Shows an inline loading state on the Deep button while the call is in flight.
 * Aborts any previous in-flight call for the same bubble automatically.
 */
async function _runDeepAnalysis(sentence, bubble, deepBtn) {
    if (!_deps)
        return;
    const prev = bubble._deepAbort;
    prev?.abort();
    const abort = new AbortController();
    bubble._deepAbort = abort;
    // ── Loading state: spinner inside button, skeleton below ──────────────
    deepBtn.dataset.loading = 'true';
    deepBtn.disabled = true;
    // Store original label to restore later
    const origLabel = deepBtn.dataset.origLabel ?? deepBtn.textContent ?? t('tap.deep');
    deepBtn.dataset.origLabel = origLabel;
    deepBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="font-size:0.85em;"></i>`;
    let deepArea = bubble.querySelector('.pg-deep-area');
    if (!deepArea) {
        deepArea = document.createElement('div');
        deepArea.className = 'pg-deep-area';
        bubble.querySelector('.pg-tap-bubble-inner')?.appendChild(deepArea);
    }
    // Skeleton rows while waiting
    deepArea.innerHTML = `
        <div class="pg-skeleton" style="height:11px;width:70%;border-radius:5px;margin:8px 0 5px;"></div>
        <div class="pg-skeleton" style="height:9px;width:90%;border-radius:5px;margin-bottom:4px;"></div>
        <div class="pg-skeleton" style="height:9px;width:75%;border-radius:5px;margin-bottom:10px;"></div>
        <div class="pg-skeleton" style="height:11px;width:60%;border-radius:5px;margin-bottom:5px;"></div>
        <div class="pg-skeleton" style="height:9px;width:85%;border-radius:5px;"></div>`;
    try {
        const raw = await _deps.callModel(API.sysJson, deepAnalysisPrompt(sentence, _deps.getLang(), _deps.getNativeLang()), abort.signal);
        if (abort.signal.aborted)
            return;
        const result = parseJSON(raw);
        _renderDeepResult(deepArea, result);
        deepBtn.innerHTML = origLabel;
        deepBtn.disabled = false;
        deepBtn.dataset.loading = 'false';
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        deepArea.innerHTML = `<div class="pg-deep-error">${t('tap.deepFailed')}</div>`;
        deepBtn.innerHTML = origLabel;
        deepBtn.disabled = false;
        deepBtn.dataset.loading = 'false';
    }
}
/**
 * Renders a DeepAnalysisResult into the given container element.
 * Draws an inline SVG dependency arc diagram above the token row,
 * then lists grammar points and the summary below.
 */
function _renderDeepResult(container, r) {
    const tokens = r.tokens ?? [];
    // ── 1. Token chips HTML (role-coloured, note as tooltip)
    const tokenChipsHtml = tokens.map((tok, i) => {
        const cls = _ROLE_CLASS[tok.role] ?? 'pg-deep-role-mod';
        const noteAttr = tok.note ? ` title="${escapeHtml(tok.note)}"` : '';
        return `<span class="pg-deep-token ${cls}" data-idx="${i}"${noteAttr}>
            <span class="pg-deep-token-text">${escapeHtml(tok.text)}</span>
            <span class="pg-deep-token-label">${escapeHtml(tok.label)}</span>
        </span>`;
    }).join('');
    // ── 2. Build dependency arc SVG
    // Strategy: render chips first (hidden), measure widths, then draw SVG.
    // Since we're in innerHTML land we estimate widths from char count.
    // Each token chip is roughly max(charWidth * 8, 36) px wide + 8px gap.
    const _CHIP_H = 52; // token chip height (text + label)
    const GAP = 8; // gap between chips
    const CHAR_W = 8.5; // px per character at 0.9em ≈ 13px
    const ARC_BASE_Y = 4; // SVG top padding
    const ARC_LANE_H = 14; // vertical space per arc "lane"
    // Compute chip widths and x positions
    const chipWidths = tokens.map(tok => Math.max(tok.text.length * CHAR_W + 16, 36));
    const chipX = [];
    let cx = 0;
    chipWidths.forEach(w => { chipX.push(cx); cx += w + GAP; });
    const totalW = cx - GAP;
    const arcs = [];
    tokens.forEach((tok, i) => {
        if (tok.head_idx === undefined || tok.head_idx < 0)
            return;
        if (tok.head_idx >= tokens.length)
            return; // guard against AI returning invalid index
        arcs.push({ from: i, to: tok.head_idx, label: tok.dep_label ?? '' });
    });
    // Assign lanes (shorter arcs = lower lanes to avoid crossing)
    const arcsSorted = [...arcs].sort((a, b) => Math.abs(a.from - a.to) - Math.abs(b.from - b.to));
    const laneOf = new Map();
    arcsSorted.forEach((arc, rank) => { laneOf.set(arc, rank); });
    const maxLane = arcs.length > 0 ? Math.max(...arcs.map((_, i) => i)) : 0;
    const svgH = ARC_BASE_Y + (maxLane + 1) * ARC_LANE_H + 6;
    // Draw arcs as quadratic bezier curves
    let arcPaths = '';
    arcs.forEach(arc => {
        const lane = laneOf.get(arc) ?? 0;
        const x1 = chipX[arc.from] + chipWidths[arc.from] / 2;
        const x2 = chipX[arc.to] + chipWidths[arc.to] / 2;
        const y = svgH - ARC_BASE_Y - lane * ARC_LANE_H;
        const cy = y - ARC_LANE_H * 1.2;
        const midX = (x1 + x2) / 2;
        const col = arc.from < arc.to ? '#4f9cf9' : '#e07b3a';
        // Arrow direction: from → head
        const _arrowX = x2 + (x1 < x2 ? -6 : 6);
        arcPaths += `
        <path d="M${x1},${y} Q${midX},${cy} ${x2},${y}"
              fill="none" stroke="${col}" stroke-width="1.2" stroke-opacity="0.6"
              marker-end="url(#da)"/>`;
        if (arc.label) {
            arcPaths += `<text x="${midX}" y="${cy - 2}"
              text-anchor="middle" font-size="9" fill="${col}" opacity="0.85"
              font-family="inherit">${escapeHtml(arc.label)}</text>`;
        }
    });
    const svgHtml = arcs.length > 0 ? `
        <div class="pg-deep-arc-wrap" style="overflow-x:auto;">
          <svg width="${totalW}" height="${svgH}" viewBox="0 0 ${totalW} ${svgH}"
               style="display:block;min-width:100%">
            <defs>
              <marker id="da" viewBox="0 0 8 8" refX="7" refY="4"
                      markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M1 1L7 4L1 7" fill="none" stroke="context-stroke"
                      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </marker>
            </defs>
            ${arcPaths}
          </svg>
        </div>` : '';
    // ── 3. Grammar points
    const grammarHtml = (r.grammar ?? []).map(g => `
        <div class="pg-deep-gram-item">
            <span class="pg-deep-gram-point">${escapeHtml(g.point)}</span>
            <span class="pg-deep-gram-exp">${escapeHtml(g.explanation)}</span>
        </div>`).join('');
    // ── 4. Summary
    const summaryHtml = r.summary
        ? `<div class="pg-deep-summary">${escapeHtml(r.summary)}</div>`
        : '';
    container.innerHTML = `
        <div class="pg-deep-result">
            ${svgHtml}
            <div class="pg-deep-tokens">${tokenChipsHtml}</div>
            ${grammarHtml ? `<div class="pg-deep-grammar">${grammarHtml}</div>` : ''}
            ${summaryHtml}
        </div>`;
}
/** Core tap-to-translate logic. */
async function runTapTranslate(node, offset, mesId) {
    const hit = _sentenceAtCaret(node, offset);
    if (!hit)
        return;
    const { sentence, textEl, anchorEl } = hit;
    // Cancel any in-progress translation for the same message
    _tapTransAborts.get(mesId)?.abort();
    const abort = new AbortController();
    _tapTransAborts.set(mesId, abort);
    const opened = _showTapBubble(textEl, anchorEl, sentence, 'loading');
    if (!opened) {
        _tapTransAborts.delete(mesId);
        return;
    } // bubble was toggled off
    try {
        const result = parseJSON(await _deps?.callModel(API.sysJson, tapTranslatePrompt(sentence, _deps?.getLang() ?? 'English', _deps?.getNativeLang() ?? 'en'), abort.signal));
        if (abort.signal.aborted)
            return;
        // Replace loading bubble with the translation result
        const existing = textEl.querySelector('.pg-tap-bubble');
        if (existing)
            existing.remove();
        _showTapBubble(textEl, anchorEl, sentence, result);
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        const existing = textEl.querySelector('.pg-tap-bubble');
        if (existing)
            existing.remove();
        _showTapBubble(textEl, anchorEl, sentence, { translation: '', error: e instanceof Error ? e.message : String(e) });
    }
    finally {
        _tapTransAborts.delete(mesId);
    }
}
export function setupTapToTranslate() {
    const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;
    // ═ Shared helper: resolve click point → (node, offset, mesId)
    function getCaretInfo(ev) {
        let range = null;
        if (document.caretRangeFromPoint) {
            range = document.caretRangeFromPoint(ev.clientX, ev.clientY);
        }
        else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(ev.clientX, ev.clientY);
            if (pos) {
                range = document.createRange();
                range.setStart(pos.offsetNode, pos.offset);
            }
        }
        if (!range)
            return null;
        const node = range.startContainer;
        const offset = range.startOffset;
        // Verify the click is inside mes_text
        const elNode = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
        const el = elNode instanceof Element ? elNode : null;
        const mesEl = el?.closest('.mes[is_user="false"]');
        if (!mesEl)
            return null;
        // Exclude clicks on pg-clickable-word to avoid conflict with word lookup
        if (el?.closest('.pg-clickable-word'))
            return null;
        const mesId = mesEl.getAttribute('mesid') ?? '';
        return { node, offset, mesId };
    }
    // ═ Desktop: double-click
    document.addEventListener('dblclick', ev => {
        if (isTouchDevice())
            return;
        const chat = document.getElementById('chat');
        if (!chat?.contains(ev.target))
            return;
        const info = getCaretInfo(ev);
        if (!info)
            return;
        // Clear browser text selection created by the double-click and suppress tooltip
        window.getSelection()?.removeAllRanges();
        removeSelTooltip();
        runTapTranslate(info.node, info.offset, info.mesId);
    });
    // ═ Mobile: long-tap (500 ms)
    let _longPressTimer = null;
    let _longPressStartX = 0;
    let _longPressStartY = 0;
    document.addEventListener('touchstart', ev => {
        if (!isTouchDevice())
            return;
        const chat = document.getElementById('chat');
        if (!chat?.contains(ev.target))
            return;
        if (ev.touches.length !== 1)
            return;
        const touch = ev.touches[0];
        _longPressStartX = touch.clientX;
        _longPressStartY = touch.clientY;
        if (_longPressTimer !== null)
            clearTimeout(_longPressTimer);
        _longPressTimer = setTimeout(() => {
            _longPressTimer = null;
            const info = getCaretInfo({ clientX: _longPressStartX, clientY: _longPressStartY });
            if (!info)
                return;
            // Haptic feedback (if supported)
            navigator.vibrate?.(40);
            runTapTranslate(info.node, info.offset, info.mesId);
        }, DELAY.longPress);
    }, { passive: true });
    document.addEventListener('touchmove', ev => {
        if (!_longPressTimer)
            return;
        const touch = ev.touches[0];
        const dx = touch.clientX - _longPressStartX;
        const dy = touch.clientY - _longPressStartY;
        // Cancel long-tap if finger moves more than 10 px (treat as scroll)
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
            if (_longPressTimer !== null)
                clearTimeout(_longPressTimer);
        }
    }, { passive: true });
    document.addEventListener('touchend', () => {
        if (_longPressTimer !== null)
            clearTimeout(_longPressTimer);
    }, { passive: true });
    // ═ Close all bubbles on chat switch
    document.addEventListener('click', ev => {
        const bubble = ev.target.closest('.pg-tap-bubble');
        if (!bubble && document.querySelector('.pg-tap-bubble')) {
            // Click outside any bubble — close all
            // Exceptions: learning panel, conjugation overlay (closing conj should not kill tap bubble)
            const target = ev.target;
            if (target.closest('#pg-box-pg-learning-panel'))
                return;
            if (target.closest('.pg-conj-overlay'))
                return;
            removeTapBubbles();
        }
    });
}
// ── Abort helpers (called by index.ts on chat switch) ─────────────────────────
/** Aborts all in-flight tap-translate requests and clears the tracker. */
export function abortAllTapTranslate() {
    _tapTransAborts.forEach(ctrl => ctrl.abort());
    _tapTransAborts.clear();
}
/** Aborts the in-flight quick-lookup request. */
export function abortQuickLookup() {
    _lookupAbort?.abort();
    _lookupAbort = null;
}
