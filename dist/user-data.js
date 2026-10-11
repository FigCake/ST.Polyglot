// The learner's own data — what data-store.ts keeps in a file on the ST
// server and backup.ts writes to a backup:
//
//   wordbook      every chat's words (with SRS progress, notes, chat tags)
//   sets          word sets
//   wrongAnswers  saved wrong quiz answers
//
// Pure — validation, merging and the file format. No DOM, no I/O.
import { SRS as SRS_CFG } from './constants.js';
import { mergeWordbooks, mergeEntries, rebaseEntry } from './wordbook-model.js';
import { isRecord } from './ai/client.js';
export const DATA_FORMAT = 'polyglot-data';
export const DATA_VERSION = 1;
export const emptyData = () => ({ wordbook: [], sets: [], wrongAnswers: [] });
export const hasData = (d) => d.wordbook.length > 0 || d.sets.length > 0 || d.wrongAnswers.length > 0;
// ── Validation ────────────────────────────────────────────────────────────────
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
export const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** Optional fields that must be text when present (anything else would break the views that read them). */
const TEXT_FIELDS = ['meaning_lang', 'pos_info', 'pos', 'ipa', 'reading', 'notes', 'original_form', 'context_meaning',
    'example', 'example_translation', 'audio', 'image', 'dateAdded'];
/** The entry without optional fields of the wrong type (a backup or chat metadata may hold anything). */
function typedFields(v) {
    const out = { ...v };
    for (const k of TEXT_FIELDS)
        if (k in out && typeof out[k] !== 'string')
            delete out[k];
    if ('collocations' in out) {
        if (Array.isArray(out.collocations))
            out.collocations = out.collocations.filter(c => typeof c === 'string');
        else
            delete out.collocations;
    }
    for (const k of ['srs_streak', 'srs_reviewed_at'])
        if (k in out && !Number.isFinite(out[k]))
            delete out[k];
    if ('conj_cached' in out && typeof out.conj_cached !== 'boolean')
        delete out.conj_cached;
    return out;
}
/** Keeps entries with a word; repairs the fields every feature relies on. */
function cleanEntry(v) {
    if (!isRecord(v) || typeof v.word !== 'string' || !v.word.trim())
        return null;
    return {
        ...typedFields(v),
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
/**
 * This session's data with the changes another device saved since `base`
 * (the file as this session last read or wrote it). Words, sets and wrong
 * answers added or deleted on either side stay added or deleted; a word
 * changed on both sides is combined field by field (rebaseEntry), or with
 * mergeEntries when both sides added it.
 */
export function rebaseUserData(base, local, server) {
    return {
        wordbook: rebase(base.wordbook, local.wordbook, server.wordbook, e => e.word, (l, r, b) => (b ? rebaseEntry(b, l, r) : mergeEntries(l, r))),
        sets: rebase(base.sets, local.sets, server.sets, s => s.id, l => l),
        wrongAnswers: rebase(base.wrongAnswers, local.wrongAnswers, server.wrongAnswers, w => w.question, l => l),
    };
}
function rebase(base, local, server, key, combine) {
    const before = new Map(base.map(x => [key(x), x]));
    const remote = new Map(server.map(x => [key(x), x]));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const out = new Map();
    for (const l of local) {
        const k = key(l), b = before.get(k), r = remote.get(k);
        if (r === undefined) {
            // Deleted elsewhere: gone, unless this session added or changed it
            if (b === undefined || !same(l, b))
                out.set(k, l);
        }
        else if (same(l, b) || same(l, r))
            out.set(k, r);
        else if (same(r, b))
            out.set(k, l);
        else
            out.set(k, combine(l, r, b));
    }
    // Added elsewhere (an item in `base` but not here was deleted here)
    for (const r of server)
        if (!out.has(key(r)) && !before.has(key(r)))
            out.set(key(r), r);
    return [...out.values()];
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
