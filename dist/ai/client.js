// The one way features talk to the model. Every request expects JSON:
//
//   reply ─▶ extractJson ─▶ accept(value) ─▶ missing(value) ─▶ ✓ complete result
//                │               │                │
//      cut off / invalid    wrong shape     fields left out
//                └───────────────┼────────────────┘
//                                ▼
//            one strict retry (same prompt + correction note)
//                        │
//              ✓ complete result
//              ✗ → partial results of both attempts, combined by `merge`
//                  (or the better one), flagged `partial`
//              ✗ → AiResponseError
//
// `accept` is the feature's validator: it returns the cleaned value, or null
// when the shape is unusable. It runs on repaired (truncated) JSON too, so it
// should drop incomplete items rather than reject the whole value.
//
// `merge` (optional) combines two partial answers — e.g. a list cut off at
// item 12 and a retry cut off at item 9 — into one with the items of both.
//
// `missing` (optional) names the expected fields a usable answer still left
// out or empty. The retry names them; an answer still missing some after it
// is returned with them listed in `missing` (the feature shows what came and
// leaves the rest empty, for the user to fill in or delete).
//
// Pure apart from the injected `complete` function — unit-testable.
import { extractJson } from './json-repair.js';
import { recordProblem, errorText } from '../diagnostics.js';
export class AiResponseError extends Error {
    raw;
    constructor(message, raw) {
        super(message);
        this.raw = raw;
        this.name = 'AiResponseError';
    }
}
const JSON_SYSTEM_PROMPT = 'You are a precise language analysis assistant. Always respond with valid JSON only. ' +
    'No preamble, no markdown fences, no extra text.';
const RETRY_NOTE = {
    truncated: () => '\n\nIMPORTANT: your previous reply was cut off before the JSON was complete. ' +
        'Reply again with the COMPLETE JSON only. Keep every string value short so it fits.',
    invalid: () => '\n\nIMPORTANT: your previous reply was not valid JSON in the requested format. ' +
        'Reply with ONLY the JSON value described above — no prose, no markdown fences.',
    incomplete: fields => `\n\nIMPORTANT: your previous reply left these fields out or empty: ${fields.slice(0, 12).join(', ')}. ` +
        'Reply again with the COMPLETE JSON only, every field described above filled in.',
};
async function attempt(complete, system, req, prompt) {
    const reply = await complete(system, prompt, req.signal ?? null);
    const extracted = extractJson(reply.text);
    const data = extracted ? req.accept(extracted.value) : null;
    if (data === null)
        return { kind: 'problem', problem: reply.truncated ? 'truncated' : 'invalid', raw: reply.text, fields: [] };
    const cutOff = reply.truncated || !extracted?.complete;
    const fields = req.missing?.(data) ?? [];
    if (!cutOff && !fields.length)
        return { kind: 'ok', result: { data, partial: false } };
    return { kind: 'problem', problem: cutOff ? 'truncated' : 'incomplete', partial: { data, partial: true }, raw: reply.text, fields };
}
/** The partial answers of both attempts as one: merged (the retry's items first), else the one missing fewer fields. */
function combine(req, retry, first) {
    const gaps = (r) => req.missing?.(r.data).length ?? 0;
    const best = retry && first
        ? req.merge ? { data: req.merge(retry.data, first.data), partial: true } : gaps(first) < gaps(retry) ? first : retry
        : retry ?? first;
    if (!best)
        return undefined;
    const missing = req.missing?.(best.data) ?? [];
    return missing.length ? { ...best, missing } : best;
}
export function createAiClient(complete, system = JSON_SYSTEM_PROMPT) {
    return {
        async json(req) {
            try {
                return await jsonOnce(req);
            }
            catch (e) {
                // Kept for "Copy diagnostics": the request's error, or the start of the reply that could not be used
                if (!req.signal?.aborted)
                    recordProblem('ai', e instanceof AiResponseError ? `${e.message} Reply: ${e.raw}` : errorText(e));
                throw e;
            }
        },
    };
    async function jsonOnce(req) {
        const first = await attempt(complete, system, req, req.prompt);
        if (first.kind === 'ok')
            return first.result;
        let second = null;
        try {
            second = await attempt(complete, system, req, req.prompt + RETRY_NOTE[first.problem](first.fields));
        }
        catch (e) {
            // A failed retry must not hide a usable first answer — unless the user cancelled.
            if (req.signal?.aborted || !first.partial)
                throw e;
        }
        if (second?.kind === 'ok')
            return second.result;
        const best = combine(req, second?.kind === 'problem' ? second.partial : undefined, first.partial);
        if (best)
            return best;
        throw new AiResponseError('The model did not return valid JSON in the expected format.', second?.raw ?? first.raw);
    }
}
// ── accept() helpers ──────────────────────────────────────────────────────────
export const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * The `keys` of `value` that are absent or empty (a blank string, null), as
 * named fields; a list counts as given even when empty. `prefix` names the
 * place of a list item ("hard_words[2].").
 */
export function missingKeys(value, keys, prefix = '') {
    const v = isRecord(value) ? value : {};
    return keys.filter(k => v[k] == null || (typeof v[k] === 'string' && !v[k].trim())).map(k => prefix + k);
}
/** `value` with every one of `keys` it lacks as a string set to '' (shown and saved empty). */
export function withEmptyFields(value, keys) {
    const out = { ...value };
    for (const k of keys)
        if (typeof out[k] !== 'string')
            out[k] = '';
    return out;
}
/** Accepts any JSON object as-is (for callers that read optional fields defensively). */
export const acceptObject = (v) => (isRecord(v) ? v : null);
/** Merges two lists, keeping `preferred`'s items and adding the other's that it lacks (by `keyOf`). */
export function unionBy(keyOf) {
    return (preferred, other) => {
        const seen = new Set(preferred.map(keyOf));
        return [...preferred, ...other.filter(item => !seen.has(keyOf(item)))];
    };
}
/** Accepts an object whose `key` is a non-empty array, after `clean` filters its items. */
export function acceptList(key, clean) {
    return (v) => {
        if (!isRecord(v))
            return null;
        const items = clean(v[key]);
        return items.length ? items : null;
    };
}
