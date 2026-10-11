// The one way features talk to the model. Every request expects JSON:
//
//   reply ─▶ extractJson ─▶ accept(value) ─▶ ✓ complete result
//                │               │
//      cut off / invalid    wrong shape
//                └───────┬───────┘
//                        ▼
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
// Pure apart from the injected `complete` function — unit-testable.
import { extractJson } from './json-repair.js';
export class AiResponseError extends Error {
    raw;
    constructor(message, raw) {
        super(message);
        this.raw = raw;
        this.name = 'AiResponseError';
    }
}
export const JSON_SYSTEM_PROMPT = 'You are a precise language analysis assistant. Always respond with valid JSON only. ' +
    'No preamble, no markdown fences, no extra text.';
const RETRY_NOTE = {
    truncated: '\n\nIMPORTANT: your previous reply was cut off before the JSON was complete. ' +
        'Reply again with the COMPLETE JSON only. Keep every string value short so it fits.',
    invalid: '\n\nIMPORTANT: your previous reply was not valid JSON in the requested format. ' +
        'Reply with ONLY the JSON value described above — no prose, no markdown fences.',
};
async function attempt(complete, system, req, prompt) {
    const reply = await complete(system, prompt, req.signal ?? null);
    const extracted = extractJson(reply.text);
    const data = extracted ? req.accept(extracted.value) : null;
    if (data === null)
        return { kind: 'problem', problem: reply.truncated ? 'truncated' : 'invalid', raw: reply.text };
    const cutOff = reply.truncated || !extracted?.complete;
    if (!cutOff)
        return { kind: 'ok', result: { data, partial: false } };
    return { kind: 'problem', problem: 'truncated', partial: { data, partial: true }, raw: reply.text };
}
/** The partial answers of both attempts as one (the retry's items first). */
function combine(req, retry, first) {
    if (!retry || !first || !req.merge)
        return retry ?? first;
    return { data: req.merge(retry.data, first.data), partial: true };
}
export function createAiClient(complete, system = JSON_SYSTEM_PROMPT) {
    return {
        async json(req) {
            const first = await attempt(complete, system, req, req.prompt);
            if (first.kind === 'ok')
                return first.result;
            let second = null;
            try {
                second = await attempt(complete, system, req, req.prompt + RETRY_NOTE[first.problem]);
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
        },
    };
}
// ── accept() helpers ──────────────────────────────────────────────────────────
export const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
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
