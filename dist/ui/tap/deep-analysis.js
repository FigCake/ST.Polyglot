// ════════════════════════════
// Polyglot  ui/tap/deep-analysis.ts
// ════════════════════════════
// "Deep" sentence breakdown inside a translation bubble: role-coloured token
// chips, dependency arcs above them, grammar points and a summary.
//
// Dependencies: html.ts, i18n.ts, prompts.ts, runtime.ts, ai/client.ts
import { html, setHtml, raw } from '../../html.js';
import { t } from '../../i18n.js';
import { deepAnalysisPrompt } from '../../prompts.js';
import { ai, getLang, getNativeLang } from '../../runtime.js';
import { isRecord } from '../../ai/client.js';
const ROLE_CLASS = {
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
// ── Arc layout (pure) ─────────────────────────────────────────────────────────
/** Chip widths are estimated from text length (the SVG is drawn before layout). */
const ARC = { gap: 8, charWidth: 8.5, chipPadding: 16, minChip: 36, top: 4, lane: 14 };
/** Positions one arc per token→head dependency; shorter arcs get lower lanes so they don't cross. */
export function layoutArcs(tokens) {
    const widths = tokens.map(tok => Math.max(String(tok.text ?? '').length * ARC.charWidth + ARC.chipPadding, ARC.minChip));
    const centers = [];
    let x = 0;
    for (const w of widths) {
        centers.push(x + w / 2);
        x += w + ARC.gap;
    }
    const width = Math.max(0, x - ARC.gap);
    const arcs = tokens
        .map((tok, from) => ({ from, to: tok.head_idx ?? -1, label: tok.dep_label ?? '' }))
        .filter(a => a.to >= 0 && a.to < tokens.length && a.to !== a.from)
        .sort((a, b) => Math.abs(a.from - a.to) - Math.abs(b.from - b.to));
    const height = ARC.top + arcs.length * ARC.lane + 6;
    const paths = arcs.map((arc, lane) => {
        const x1 = centers[arc.from], x2 = centers[arc.to];
        const y = height - ARC.top - lane * ARC.lane;
        const cy = y - ARC.lane * 1.2;
        return { d: `M${x1},${y} Q${(x1 + x2) / 2},${cy} ${x2},${y}`, labelX: (x1 + x2) / 2, labelY: cy - 2, label: arc.label, forward: arc.from < arc.to };
    });
    return { width, height, paths };
}
// ── Rendering ─────────────────────────────────────────────────────────────────
let markerSeq = 0;
function arcsSvg(tokens) {
    const { width, height, paths } = layoutArcs(tokens);
    if (!paths.length)
        return raw('');
    const marker = `pg-deep-arrow-${++markerSeq}`; // unique per bubble — ids are document-global
    return html `
        <div class="pg-deep-arc-wrap">
            <svg class="pg-deep-arcs" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
                <defs>
                    <marker id="${marker}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                        <path d="M1 1L7 4L1 7" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </marker>
                </defs>
                ${paths.map(p => html `
                <g class="${p.forward ? 'pg-deep-arc-fwd' : 'pg-deep-arc-back'}">
                    <path d="${p.d}" marker-end="url(#${marker})"/>
                    ${p.label && html `<text x="${p.labelX}" y="${p.labelY}" text-anchor="middle">${p.label}</text>`}
                </g>`)}
            </svg>
        </div>`;
}
function resultView(r) {
    const tokens = r.tokens ?? [];
    const grammar = r.grammar ?? [];
    return html `
        <div class="pg-deep-result">
            ${arcsSvg(tokens)}
            <div class="pg-deep-tokens">${tokens.map((tok, i) => html `
                <span class="pg-deep-token ${ROLE_CLASS[tok.role] ?? 'pg-deep-role-mod'}" data-idx="${i}" title="${tok.note ?? ''}">
                    <span class="pg-deep-token-text">${tok.text}</span>
                    <span class="pg-deep-token-label">${tok.label}</span>
                </span>`)}
            </div>
            ${grammar.length > 0 && html `
            <div class="pg-deep-grammar">${grammar.map(g => html `
                <div class="pg-deep-gram-item">
                    <span class="pg-deep-gram-point">${g.point}</span>
                    <span class="pg-deep-gram-exp">${g.explanation}</span>
                </div>`)}
            </div>`}
            ${r.summary && html `<div class="pg-deep-summary">${r.summary}</div>`}
        </div>`;
}
const loadingView = html `
    <div class="pg-deep-skeleton">
        <div class="pg-skeleton"></div><div class="pg-skeleton"></div><div class="pg-skeleton"></div>
        <div class="pg-skeleton"></div><div class="pg-skeleton"></div>
    </div>`;
const acceptDeep = (v) => isRecord(v) && Array.isArray(v.tokens)
    ? { ...v, tokens: v.tokens.filter(tok => isRecord(tok) && typeof tok.text === 'string') }
    : null;
const requests = new WeakMap();
/** Cancels a bubble's pending deep analysis (when the bubble closes). */
export function cancelDeepAnalysis(bubble) {
    requests.get(bubble)?.abort();
}
/** Requests and renders the breakdown into the bubble; the button shows progress. */
export async function runDeepAnalysis(sentence, bubble, button) {
    if (button.disabled)
        return;
    cancelDeepAnalysis(bubble);
    const request = new AbortController();
    requests.set(bubble, request);
    let area = bubble.querySelector('.pg-deep-area');
    if (!area) {
        area = Object.assign(document.createElement('div'), { className: 'pg-deep-area' });
        bubble.querySelector('.pg-tap-bubble-inner')?.appendChild(area);
    }
    const label = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    setHtml(button, html `<i class="fa-solid fa-spinner fa-spin"></i>`);
    setHtml(area, loadingView);
    try {
        const { data } = await ai.json({
            prompt: deepAnalysisPrompt(sentence, getLang(), getNativeLang()),
            signal: request.signal,
            accept: acceptDeep,
        });
        if (!request.signal.aborted)
            setHtml(area, resultView(data));
    }
    catch {
        if (!request.signal.aborted)
            setHtml(area, html `<div class="pg-deep-error">${t('tap.deepFailed')}</div>`);
    }
    finally {
        button.innerHTML = label;
        button.disabled = false;
        button.removeAttribute('aria-busy');
    }
}
