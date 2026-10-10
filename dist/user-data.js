// ════════════════════════════
// Polyglot  user-data.ts
// ════════════════════════════
// The learner's own data — what data-store.ts keeps in a file on the ST
// server and backup.ts writes to a backup:
//
//   wordbook      every chat's words (with SRS progress, notes, chat tags)
//   sets          word sets
//   wrongAnswers  saved wrong quiz answers
//
// Pure — validation, merging and the file format. No DOM, no I/O.
import { SRS as SRS_CFG } from './constants.js';
import { mergeWordbooks } from './wordbook-model.js';
export const DATA_FORMAT = 'polyglot-data';
export const DATA_VERSION = 1;
export const emptyData = () => ({ wordbook: [], sets: [], wrongAnswers: [] });
export const hasData = (d) => d.wordbook.length > 0 || d.sets.length > 0 || d.wrongAnswers.length > 0;
// ── Validation ────────────────────────────────────────────────────────────────
export const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
export const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** Keeps entries with a word; repairs the fields every feature relies on. */
function cleanEntry(v) {
    if (!isRecord(v) || typeof v.word !== 'string' || !v.word.trim())
        return null;
    return {
        ...v,
        base_form: typeof v.base_form === 'string' ? v.base_form : v.word,
        meaning: typeof v.meaning === 'string' ? v.meaning : '',
        level: typeof v.level === 'string' ? v.level : '',
        setIds: strings(v.setIds),
        chats: strings(v.chats),
        srs_interval: num(v.srs_interval, SRS_CFG.initialInterval),
        srs_ease: num(v.srs_ease, SRS_CFG.defaultEase),
        srs_due: num(v.srs_due, 0),
    };
}
export const list = (v, keep) => (Array.isArray(v) ? v.filter(keep) : []);
const isSet = (v) => isRecord(v) && typeof v.id === 'string' && typeof v.name === 'string';
const isWrong = (v) => isRecord(v) && typeof v.question === 'string';
/** Validated data from untrusted fields; unusable items are dropped, not fatal. */
export function cleanData(raw) {
    return {
        wordbook: (Array.isArray(raw.wordbook) ? raw.wordbook : []).map(cleanEntry).filter((e) => e !== null),
        sets: list(raw.sets, isSet),
        wrongAnswers: list(raw.wrongAnswers, isWrong),
    };
}
/**
 * `incoming` folded into `current`: new words are added, duplicates combined
 * (wordbook-model.mergeEntries), missing sets / wrong answers added.
 */
export function mergeUserData(current, incoming) {
    const { wordbook, added, merged } = mergeWordbooks(current.wordbook, incoming.wordbook);
    const setIds = new Set(current.sets.map(s => s.id));
    const questions = new Set(current.wrongAnswers.map(w => w.question));
    return {
        wordbook, added, merged,
        sets: [...current.sets, ...incoming.sets.filter(s => !setIds.has(s.id))],
        wrongAnswers: [...current.wrongAnswers, ...incoming.wrongAnswers.filter(w => !questions.has(w.question))],
    };
}
// ── File format ───────────────────────────────────────────────────────────────
export function serializeData(data, now = new Date()) {
    return JSON.stringify({
        format: DATA_FORMAT,
        version: DATA_VERSION,
        savedAt: now.toISOString(),
        wordbook: data.wordbook,
        sets: data.sets,
        wrongAnswers: data.wrongAnswers,
    });
}
/** Reads a data file. A file from a newer version is refused so it is never overwritten with less. */
export function parseData(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return { ok: false, reason: 'invalid' };
    }
    if (!isRecord(raw) || raw.format !== DATA_FORMAT)
        return { ok: false, reason: 'invalid' };
    if (num(raw.version, 0) > DATA_VERSION)
        return { ok: false, reason: 'newer' };
    return { ok: true, data: cleanData(raw) };
}
