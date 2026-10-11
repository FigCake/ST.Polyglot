// Extracts the first JSON value from a model reply, repairing what models
// typically get wrong:
//
//   • prose or ``` fences around the JSON
//   • trailing commas            {"a": 1,}
//   • raw line breaks in strings "line one
//                                 line two"
//   • truncation (max_tokens hit) {"items": [{"a": 1}, {"a": 2
//       → closed at the last point where the value was still well-formed;
//         the half-written trailing element is dropped
//
// Pure — no DOM, no I/O.
/** Element boundaries tried when repairing a cut-off reply (bounds the work on hopeless input). */
const MAX_CUT_ATTEMPTS = 20;
/** Walks the reply from its first `{` / `[` until the matching close (or the end). */
function scan(raw) {
    const start = raw.search(/[{[]/);
    if (start === -1)
        return null;
    let text = '';
    const stack = [];
    const checkpoints = [];
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === '\\')
                escaped = true;
            else if (ch === '"')
                inString = false;
            else if (ch === '\n') {
                text += '\\n';
                continue;
            }
            else if (ch === '\r')
                continue;
            text += ch;
            continue;
        }
        if (ch === '"')
            inString = true;
        else if (ch === '{')
            stack.push('}');
        else if (ch === '[')
            stack.push(']');
        else if (ch === '}' || ch === ']')
            stack.pop();
        else if (ch === ',')
            checkpoints.push({ at: text.length, stack: [...stack] });
        text += ch;
        if (!stack.length)
            break; // first complete top-level value
    }
    return { text, stack, inString, checkpoints };
}
const closeAll = (stack) => [...stack].reverse().join('');
/** Whether the next non-whitespace character from `from` closes a container. */
function closesNext(text, from) {
    let i = from;
    while (i < text.length && /\s/.test(text[i]))
        i++;
    return text[i] === '}' || text[i] === ']';
}
/** Removes commas that directly precede a closing bracket (outside strings). */
function dropTrailingCommas(text) {
    let out = '';
    let inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === '\\')
                escaped = true;
            else if (ch === '"')
                inString = false;
        }
        else if (ch === '"') {
            inString = true;
        }
        else if (ch === ',' && closesNext(text, i + 1)) {
            continue;
        }
        out += ch;
    }
    return out;
}
function tryParse(text) {
    for (const candidate of [text, dropTrailingCommas(text)]) {
        try {
            return { ok: true, value: JSON.parse(candidate) };
        }
        catch { /* next */ }
    }
    return { ok: false };
}
/** Candidate texts for a truncated value, most complete first. */
function* truncationRepairs(s) {
    // 1. Close in place: finish an open string, drop a dangling `,` / `"key":` / `"key"`.
    let tail = s.text + (s.inString ? '"' : '');
    tail = tail
        .replace(/,\s*$/, '')
        .replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, '');
    // Inside an object a bare trailing string is a key without a value
    if (s.stack.at(-1) === '}')
        tail = tail.replace(/([{,])\s*"(?:[^"\\]|\\.)*"\s*$/, (_, p) => (p === '{' ? '{' : ''));
    yield tail + closeAll(s.stack);
    // 2. Cut back to an earlier element boundary, newest first. Each try is a full
    //    JSON.parse, so a reply that is broken throughout must not cost one per comma.
    for (const cp of s.checkpoints.slice(-MAX_CUT_ATTEMPTS).reverse()) {
        yield s.text.slice(0, cp.at) + closeAll(cp.stack);
    }
}
/** Returns the first JSON value in `raw`, or null when nothing usable can be recovered. */
export function extractJson(raw) {
    const s = scan(String(raw ?? ''));
    if (!s)
        return null;
    if (!s.stack.length && !s.inString) {
        const parsed = tryParse(s.text);
        return parsed.ok ? { value: parsed.value, complete: true } : null;
    }
    for (const candidate of truncationRepairs(s)) {
        const parsed = tryParse(candidate);
        if (parsed.ok)
            return { value: parsed.value, complete: false };
    }
    return null;
}
