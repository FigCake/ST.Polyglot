// The learner's own data — what data-store.ts keeps in a file on the ST
// server and backup.ts writes to a backup:
//
//   wordbook      every chat's words (with SRS progress, notes, chat tags)
//   sets          word sets
//   wrongAnswers  saved wrong quiz answers
//   checks        messages the input checker corrected (the newest CHECKS_KEPT)
//   days          study totals per day (new words, reviews, forgotten)
//
// Pure — validation, merging and the file format. No DOM, no I/O.
import { mergeWordbooks, mergeEntries, rebaseEntry, keptAfterDeletion } from './wordbook-model.js';
import { isRecord } from './ai/client.js';
/** How many corrected messages the archive keeps. */
export const CHECKS_KEPT = 100;
/** The newest CHECKS_KEPT checks, newest first. */
export const recentChecks = (list) => [...list].sort((a, b) => b.at - a.at).slice(0, CHECKS_KEPT);
export const DATA_FORMAT = 'polyglot-data';
/**
 * 2: the correction archive and study days. Older versions write back only
 * the fields they know, so a tab still running one would drop them; a newer
 * version number makes it refuse the file instead (parseData: 'newer').
 */
const DATA_VERSION = 2;
export const emptyData = () => ({ wordbook: [], sets: [], wrongAnswers: [], checks: [], days: [] });
export const hasData = (d) => d.wordbook.length > 0 || d.sets.length > 0 || d.wrongAnswers.length > 0 || d.checks.length > 0 || d.days.length > 0;
// ── Validation ────────────────────────────────────────────────────────────────
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
export const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** Optional fields that must be text when present (anything else would break the views that read them). */
const TEXT_FIELDS = ['meaning_lang', 'pos_info', 'pos', 'ipa', 'reading', 'notes', 'original_form', 'context_meaning',
    'example', 'example_translation', 'example_form', 'example_audio', 'audio', 'image', 'dateAdded'];
const SRS_NUMBERS = ['srs_stability', 'srs_difficulty', 'srs_due', 'srs_reviewed_at', 'srs_lapses',
    'srs_interval', 'srs_ease', 'srs_streak'];
/** The entry without optional fields of the wrong type (a backup or chat metadata may hold anything). */
function typedFields(v) {
    const out = { ...v };
    for (const k of TEXT_FIELDS)
        if (k in out && typeof out[k] !== 'string')
            delete out[k];
    for (const k of ['collocations', 'made_sounds']) {
        if (!(k in out))
            continue;
        if (Array.isArray(out[k]))
            out[k] = out[k].filter(c => typeof c === 'string');
        else
            delete out[k];
    }
    for (const k of SRS_NUMBERS)
        if (k in out && !Number.isFinite(out[k]))
            delete out[k];
    // A word never reviewed is new: the SM-2 defaults older versions gave it are dropped
    if (out.srs_reviewed_at === undefined && out.srs_stability === undefined) {
        for (const k of ['srs_interval', 'srs_ease', 'srs_due', 'srs_streak'])
            delete out[k];
    }
    if ('conj_cached' in out && typeof out.conj_cached !== 'boolean')
        delete out.conj_cached;
    if ('known' in out && out.known !== true)
        delete out.known;
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
        ...(v.langs !== undefined && { langs: strings(v.langs) }),
    };
}
export const list = (v, keep) => (Array.isArray(v) ? v.filter(keep) : []);
const isSet = (v) => isRecord(v) && typeof v.id === 'string' && typeof v.name === 'string';
const isWrong = (v) => isRecord(v) && typeof v.question === 'string';
function cleanCheck(v) {
    if (!isRecord(v) || typeof v.id !== 'string' || typeof v.original !== 'string')
        return null;
    const text = (x) => (typeof x === 'string' ? x : '');
    return {
        id: v.id, at: num(v.at, 0), lang: text(v.lang), original: v.original,
        grammar: text(v.grammar), natural: text(v.natural), explanation: text(v.explanation),
        ...(typeof v.note === 'string' && v.note && { note: v.note }),
    };
}
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const count = (v) => Math.max(0, Math.round(num(v, 0)));
const byDate = (list) => list.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
const maxDay = (a, b) => ({ d: a.d, n: Math.max(a.n, b.n), r: Math.max(a.r, b.r), a: Math.max(a.a, b.a) });
/** Days of the same date combined (the larger totals: they are the same day counted twice). */
function unionDays(lists) {
    const days = new Map();
    for (const day of lists.flat()) {
        const seen = days.get(day.d);
        days.set(day.d, seen ? maxDay(seen, day) : day);
    }
    return byDate([...days.values()]);
}
function cleanDays(v) {
    const days = (Array.isArray(v) ? v : [])
        .filter(x => isRecord(x) && typeof x.d === 'string' && DAY_KEY.test(x.d))
        .map((x) => ({ d: x.d, n: count(x.n), r: count(x.r), a: count(x.a) }));
    return unionDays([days]);
}
/** Validated data from untrusted fields; unusable items are dropped, not fatal. */
export function cleanData(raw) {
    return {
        wordbook: (Array.isArray(raw.wordbook) ? raw.wordbook : []).map(cleanEntry).filter((e) => e !== null),
        sets: list(raw.sets, isSet),
        wrongAnswers: list(raw.wrongAnswers, isWrong),
        checks: recentChecks((Array.isArray(raw.checks) ? raw.checks : []).map(cleanCheck).filter((c) => c !== null)),
        days: cleanDays(raw.days),
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
    const checkIds = new Set(current.checks.map(c => c.id));
    return {
        wordbook, added, merged,
        sets: [...current.sets, ...incoming.sets.filter(s => !setIds.has(s.id))],
        wrongAnswers: [...current.wrongAnswers, ...incoming.wrongAnswers.filter(w => !questions.has(w.question))],
        checks: recentChecks([...current.checks, ...incoming.checks.filter(c => !checkIds.has(c.id))]),
        days: unionDays([current.days, incoming.days]),
    };
}
/**
 * This session's data with the changes another device saved since `base`
 * (the file as this session last read or wrote it). Words, sets and wrong
 * answers added or deleted on either side stay added or deleted; a word
 * changed on both sides is combined field by field (rebaseEntry), or with
 * mergeEntries when both sides added it. A word deleted elsewhere comes back
 * only if the learner edited it here (keptAfterDeletion).
 */
export function rebaseUserData(base, local, server) {
    const serverMedia = new Set(server.wordbook.flatMap(e => [e.audio, e.example_audio, e.image]));
    return {
        wordbook: rebase(base.wordbook, local.wordbook, server.wordbook, e => e.word, (l, r, b) => (b ? rebaseEntry(b, l, r) : mergeEntries(l, r)), (l, b) => keptAfterDeletion(b, l, serverMedia)),
        sets: rebase(base.sets, local.sets, server.sets, s => s.id, l => l),
        wrongAnswers: rebase(base.wrongAnswers, local.wrongAnswers, server.wrongAnswers, w => w.question, l => l),
        checks: recentChecks(rebase(base.checks, local.checks, server.checks, c => c.id, l => l)),
        days: rebaseDays(base.days, local.days, server.days),
    };
}
/** Day totals with what this session counted since `base` added to the server's. */
function rebaseDays(base, local, server) {
    const zero = (d) => ({ d, n: 0, r: 0, a: 0 });
    const index = (list) => new Map(list.map(x => [x.d, x]));
    const b = index(base), l = index(local), s = index(server);
    const sum = (d, k) => Math.max(0, (s.get(d) ?? zero(d))[k] + (l.get(d) ?? zero(d))[k] - (b.get(d) ?? zero(d))[k]);
    return byDate([...new Set([...l.keys(), ...s.keys()])].map(d => ({ d, n: sum(d, 'n'), r: sum(d, 'r'), a: sum(d, 'a') })));
}
function rebase(base, local, server, key, combine, 
/** What stays of an item deleted elsewhere that this session changed (null: nothing). */
revive = l => l) {
    const before = new Map(base.map(x => [key(x), x]));
    const remote = new Map(server.map(x => [key(x), x]));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const out = new Map();
    for (const l of local) {
        const k = key(l), b = before.get(k), r = remote.get(k);
        if (r === undefined) {
            // Deleted elsewhere: gone, unless this session added or changed it
            const kept = b === undefined ? l : same(l, b) ? null : revive(l, b);
            if (kept)
                out.set(k, kept);
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
        checks: data.checks,
        days: data.days,
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
