// Validates and repairs AI-generated quiz questions before they are rendered.
//
// Why: a quiz only shows its score / retry / save-wrong controls once every
// card has been answered. A single malformed question (no options, answer not
// among the options, duplicate options…) used to leave a card that could not
// be answered — or could only be answered "wrong" — so the quiz never finished.
//
// Guarantees for every returned question:
//   • non-empty `question`
//   • 2+ distinct, non-empty `options` (at most MAX_OPTIONS)
//   • `answer` is exactly one of `options` (same string), so the renderer can
//     mark the correct button and compare by identity
//
// Pure — no DOM, no ST state.
const MAX_OPTIONS = 4;
/** Comparison key: Unicode-normalised, case-insensitive, whitespace-collapsed. */
export function answerKey(s) {
    return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}
const asText = (v) => typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
/**
 * Accepts an array, or an object such as { A: "…", B: "…" }. Drops blanks and
 * duplicates (by answerKey); of variants that differ only in case or spacing,
 * the one spelled exactly like the answer is kept, so a capitalisation
 * question never ends up marking the wrong spelling correct.
 */
function readOptions(raw, answer) {
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object') ? Object.values(raw) : [];
    const byKey = new Map();
    for (const opt of list.map(asText)) {
        if (!opt)
            continue;
        const key = answerKey(opt);
        if (!byKey.has(key) || opt === answer)
            byKey.set(key, opt);
    }
    return [...byKey.values()];
}
/**
 * Finds the option the answer refers to: an exact/normalised match, or a
 * letter / 1-based index ("B", "b)", "2") pointing into the options.
 */
function findAnswerIndex(answer, options) {
    const key = answerKey(answer);
    const direct = options.findIndex(o => answerKey(o) === key);
    if (direct !== -1)
        return direct;
    const letter = /^([a-z])[).:]?$/i.exec(answer.trim());
    if (letter) {
        const i = letter[1].toLowerCase().charCodeAt(0) - 97;
        if (i < options.length)
            return i;
    }
    const num = /^(\d+)[).:]?$/.exec(answer.trim());
    if (num) {
        const i = Number(num[1]) - 1;
        if (i >= 0 && i < options.length)
            return i;
    }
    return -1;
}
/**
 * Ensures the answer is among the options. If it is missing, it takes the
 * place of a distractor (keeping the list within MAX_OPTIONS) at a random
 * position, so the correct choice is not always last.
 */
function placeAnswer(answer, options, random) {
    const distractors = options.slice(0, MAX_OPTIONS - 1);
    const at = Math.floor(random() * (distractors.length + 1));
    return [...distractors.slice(0, at), answer, ...distractors.slice(at)];
}
export function sanitizeQuestion(raw, random = Math.random) {
    if (!raw || typeof raw !== 'object')
        return null;
    const q = raw;
    const question = asText(q.question);
    let answer = asText(q.answer);
    let options = readOptions(q.options, answer);
    if (!question || !answer)
        return null;
    const idx = findAnswerIndex(answer, options);
    if (idx !== -1)
        answer = options[idx]; // canonical spelling
    else
        options = placeAnswer(answer, options, random);
    if (options.length > MAX_OPTIONS) {
        const others = options.filter(o => o !== answer).slice(0, MAX_OPTIONS - 1);
        options = options.filter(o => o === answer || others.includes(o));
    }
    if (options.length < 2)
        return null;
    const passage = asText(q.passage);
    return {
        type: asText(q.type),
        question,
        options,
        answer,
        explanation: asText(q.explanation),
        ...(passage ? { passage } : {}),
    };
}
/** Repairs what can be repaired and drops what cannot. */
export function sanitizeQuestions(raw, random = Math.random) {
    const list = Array.isArray(raw) ? raw : [];
    return list.map(q => sanitizeQuestion(q, random)).filter((q) => q !== null);
}
