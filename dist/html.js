// ════════════════════════════
// Polyglot  html.ts
// ════════════════════════════
// Auto-escaping `html` tagged template for string-built markup.
//
//   html`<b>${userText}</b>`          → userText is escaped
//   html`<ul>${items.map(i => html`<li>${i}</li>`)}</ul>`
//                                      → nested templates / arrays pass through
//   html`${raw(trustedMarkup)}`        → explicit opt-out
//   html`${cond && html`<i>…</i>`}`    → null / undefined / false render nothing
//
// Escaping is the default, so forgetting escapeHtml() can no longer open an
// XSS hole. Pure — no DOM access — so templates are unit-testable.
import { escapeHtml } from './ui.manager.js';
const SAFE = Symbol('pg-safe-html');
/** Marks a trusted string as markup so `html` will not escape it. */
export function raw(value) {
    return { [SAFE]: true, value, toString: () => value };
}
function isSafe(v) {
    return typeof v === 'object' && v !== null && SAFE in v;
}
function interpolate(v) {
    if (v == null || v === false)
        return '';
    if (isSafe(v))
        return v.value;
    if (Array.isArray(v))
        return v.map(interpolate).join('');
    return escapeHtml(v);
}
export function html(strings, ...values) {
    return raw(strings.reduce((out, s, i) => out + s + (i < values.length ? interpolate(values[i]) : ''), ''));
}
/** Replaces an element's content with the given template. */
export function setHtml(el, tpl) {
    el.innerHTML = tpl.value;
}
