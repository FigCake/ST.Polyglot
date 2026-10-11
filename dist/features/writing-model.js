// Exam-style writing practice and typed grammar questions, pitched at the
// learner's CEFR level and shaped like the tasks standardised language exams
// share (a letter or email, an opinion text; one-word grammar gaps), without
// copying any one exam.
//
// Pure — no DOM, no ST state.
import { CEFR_LEVELS } from '../constants.js';
import { isRecord } from '../ai/client.js';
// ── Length ────────────────────────────────────────────────────────────────────
/** Languages whose texts are measured in characters, as their exams do (no word spaces, or 원고지 counting). */
export const countsCharacters = (lang) => /japanese|日本語|chinese|中文|汉语|普通话|mandarin|cantonese|korean|한국어/i.test(lang);
/** Target length per CEFR level: typical of what exams ask for at that level. */
const WORDS = {
    A1: [30, 50], A2: [60, 80], B1: [100, 150], B2: [150, 200], C1: [220, 260], C2: [300, 400],
};
const CHARS = {
    A1: [80, 150], A2: [150, 250], B1: [250, 400], B2: [400, 600], C1: [600, 800], C2: [800, 1000],
};
export function lengthTarget(level, lang) {
    const chars = countsCharacters(lang);
    const [min, max] = (chars ? CHARS : WORDS)[level] ?? (chars ? CHARS.B1 : WORDS.B1);
    return { min, max, unit: chars ? 'chars' : 'words' };
}
/** Words (tokens with a letter or digit), or non-space characters for character-counted languages. */
export function countText(text, unit) {
    if (unit === 'chars')
        return text.replace(/\s/g, '').length;
    return text.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}
// ── AI replies ────────────────────────────────────────────────────────────────
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const texts = (v, max) => (Array.isArray(v) ? v.map(text).filter(Boolean).slice(0, max) : []);
export function acceptWritingTask(v) {
    if (!isRecord(v))
        return null;
    const instructions = text(v.instructions);
    if (!instructions)
        return null;
    const register = v.register === 'formal' || v.register === 'informal' ? v.register : 'neutral';
    return { title: text(v.title), instructions, points: texts(v.points, 6), register, native: text(v.instructions_native) };
}
/** The four criteria exam raters commonly use, each 0–3. */
export const CRITERIA = ['task', 'coherence', 'accuracy', 'range'];
const ERROR_TYPES = new Set(['grammar', 'vocabulary', 'spelling', 'punctuation', 'register', 'style']);
const score = (v) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : 0;
};
/** Cleans feedback; `original` stands in for a missing corrected text. Needs scores to be usable. */
export function acceptFeedback(original) {
    return (v) => {
        if (!isRecord(v) || !isRecord(v.scores))
            return null;
        const raw = v.scores;
        const level = text(v.level).toUpperCase();
        const errors = (Array.isArray(v.errors) ? v.errors : []).filter(isRecord).map(e => ({
            original: text(e.original),
            correction: text(e.correction),
            type: (ERROR_TYPES.has(text(e.type)) ? text(e.type) : 'grammar'),
            explanation: text(e.explanation),
        })).filter(e => e.original && e.correction && e.original !== e.correction).slice(0, 40);
        return {
            scores: Object.fromEntries(CRITERIA.map(c => [c, score(raw[c])])),
            level: CEFR_LEVELS.includes(level) ? level : '',
            summary: text(v.summary),
            corrected: text(v.corrected) || original,
            errors,
            model: text(v.model),
        };
    };
}
/** Words with their following spaces kept apart, or single characters for unspaced text. */
const tokens = (s, chars) => (chars ? [...s] : s.split(/(\s+)/).filter(Boolean));
/** Larger texts are shown without marks rather than spending seconds on the table. */
const MAX_CELLS = 4_000_000;
/**
 * What changed from `before` to `after`, by word (by character for unspaced
 * languages): a longest-common-subsequence diff. Null when the texts are too
 * long to compare quickly.
 */
export function diffText(before, after, chars = false) {
    const a = tokens(before, chars), b = tokens(after, chars);
    if ((a.length + 1) * (b.length + 1) > MAX_CELLS)
        return null;
    const w = b.length + 1;
    const lcs = new Uint16Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
        }
    }
    const parts = [];
    const push = (kind, t) => {
        const last = parts[parts.length - 1];
        if (last?.kind === kind)
            last.text += t;
        else
            parts.push({ kind, text: t });
    };
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push('same', a[i]);
            i++;
            j++;
        }
        else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
            push('del', a[i++]);
        }
        else {
            push('ins', b[j++]);
        }
    }
    while (i < a.length)
        push('del', a[i++]);
    while (j < b.length)
        push('ins', b[j++]);
    return parts;
}
// ── Typed grammar questions ───────────────────────────────────────────────────
export const BLANK = '___';
/** Keeps questions with exactly one blank and at least one answer; any run of 3+ underscores counts as the blank. */
export function acceptTypedQuestions(v) {
    if (!isRecord(v) || !Array.isArray(v.questions))
        return null;
    const out = v.questions.filter(isRecord).map(q => ({
        sentence: text(q.sentence).replace(/_{3,}/g, BLANK),
        hint: text(q.hint),
        answers: texts(q.answers, 5),
        point: text(q.point),
        explanation: text(q.explanation),
    })).filter(q => q.sentence.split(BLANK).length === 2 && q.answers.length > 0);
    return out.length ? out : null;
}
/** Comparison form of an answer: normalised, case-insensitive, single-spaced, no surrounding punctuation. */
const answerForm = (s) => s.normalize('NFC').toLocaleLowerCase().trim()
    .replace(/\s+/g, ' ').replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
const withoutMarks = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
/**
 * Grades a typed answer. 'close' = right but for accents or marks (está/esta)
 * — still wrong, since exams count it, but shown as a near miss.
 */
export function gradeTyped(input, answers) {
    const given = answerForm(input);
    if (!given)
        return 'wrong';
    const forms = answers.map(answerForm);
    if (forms.includes(given))
        return 'correct';
    return forms.some(f => withoutMarks(f) === withoutMarks(given)) ? 'close' : 'wrong';
}
