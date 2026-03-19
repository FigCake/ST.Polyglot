// ════════════════════════════
// Polyglot  utils.ts
// ════════════════════════════
// Pure utility functions — no side effects, no DOM, no API calls.
// Dependencies: constants.ts (resolveNativeLang).
import { resolveNativeLang } from './constants.js';
// ── Language helpers ───────────────────────────────────────────────────────────
// These helpers extract the resolved language strings from a Settings object.
// Defined here (not in index.ts) so annotator.ts, wordbook.ts, and index.ts
// can all share the same logic without creating a circular dependency.
/**
 * Returns the current learning language string from settings.
 * Falls back to 'English' when the language is absent or set to 'Custom'
 * without a custom value.
 */
export function getLangFromSettings(s) {
    return s?.language === 'Custom'
        ? (s.language_custom || 'English')
        : (s?.language || 'English');
}
/**
 * Returns the resolved native-language name for use in AI prompts
 * (e.g. "Korean", "English", "Italian").
 */
export function getNativeLangFromSettings(s) {
    return resolveNativeLang(s?.native_lang ?? 'en', s?.native_lang_custom ?? '');
}
// ── JSON parsing ──────────────────────────────────────────────────────────────
/**
 * Robustly parses an AI model response as JSON.
 *
 * Pass 1 — strip markdown code fences (```json … ```) then parse directly.
 * Pass 2 — extract the outermost { } or [ ] using indexOf/lastIndexOf.
 *           O(N) and safe — no catastrophic-backtracking risk.
 *
 * Throws SyntaxError if all passes fail.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJSON(raw) {
    const s = String(raw).trim();
    // Pass 1: strip markdown fences, then attempt a direct parse
    const cleaned = s.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    try {
        return JSON.parse(cleaned);
    }
    catch (_) { /* fall through */ }
    // Pass 2 & 3: extract outermost { } or [ ] from both the original and cleaned strings
    for (const src of [s, cleaned]) {
        const fb = src.indexOf('{'), lb = src.lastIndexOf('}');
        const fa = src.indexOf('['), la = src.lastIndexOf(']');
        const isObj = fb !== -1 && lb > fb;
        const isArr = fa !== -1 && la > fa;
        try {
            if (isObj && (!isArr || fb < fa))
                return JSON.parse(src.substring(fb, lb + 1));
            if (isArr)
                return JSON.parse(src.substring(fa, la + 1));
        }
        catch (_) { /* fall through */ }
    }
    console.error('[Polyglot] JSON parse failed. Raw response:', s.slice(0, 400));
    throw new SyntaxError('Failed to parse AI response as JSON. The model did not return valid JSON.');
}
// ── Array utilities ───────────────────────────────────────────────────────────
/**
 * Fisher-Yates shuffle — unbiased O(n), returns a new array (non-mutating).
 * Use instead of .sort(() => Math.random() - 0.5) which is biased and O(n log n).
 */
export function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
// ── Level display helpers ─────────────────────────────────────────────────────
// Used by annotator.ts, wordbook-ui.ts, and flashcard.ts.
/** Converts a CEFR level label to its CSS class name. */
export function levelClass(level) {
    if (!level)
        return 'grammar';
    if (level === 'grammar')
        return 'grammar';
    if (level === 'sentence')
        return 'sentence';
    if (level === 'idiom')
        return 'idiom';
    return level; // A1–C2 map to themselves
}
/** Human-readable label for a level value. */
export function levelLabel(level) {
    if (!level)
        return '?';
    if (level === 'grammar')
        return 'Gram.';
    if (level === 'sentence')
        return 'Sent.';
    if (level === 'idiom')
        return 'Idiom';
    return level; // A1–C2 as-is
}
