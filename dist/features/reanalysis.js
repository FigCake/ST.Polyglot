// AI batch re-analysis — enriches existing wordbook entries with
// pos, ipa, collocations, a verified base_form, and fills an empty
// meaning or CEFR level (e.g. after a CSV / Anki import).
//
// Design rules:
//   • Pure feature module — no direct ST state reads.
//     All deps (ai, getLang, getNativeLang) injected via ReanalysisDeps.
//   • Words go in sequential batches of BATCH_SIZE (one request each) to stay
//     within rate limits; words a batch reply misses are retried one by one.
//   • Only overwrites: pos, ipa, collocations, base_form (if corrected).
//     Fills meaning / level only when they are empty — never replaces them.
//     Never touches: notes, srs_*, setIds, dateAdded, example*.
//   • When base_form changes, conj_cached is reset to false so stale
//     conjugation tables are not shown for the new base form.
//   • A field the reply does not give leaves the entry's value alone; a reply
//     the client had to repair after it was cut off is never applied (its
//     last value may be half-written): the batch's words go one by one.
//   • A field the learner edited while the request ran (it no longer has the
//     value the request was made with) keeps the learner's value.
//   • AbortController allows the user to stop mid-batch at any time.
//   • On abort or error the wordbook is saved with whatever was completed.
//   • Failures in a row stop the run, so a provider that is down, or a model
//     that never answers in JSON, does not cost a request per word; words that
//     could not be analysed are counted and reported.
import { POS_TAGS, CEFR_LEVELS } from '../constants.js';
import { reanalysisPrompt, batchReanalysisPrompt } from '../prompts.js';
import { loadWordbook, saveWordbook } from '../wordbook.js';
import { deleteConjCache } from '../conj-cache.js';
import { isRecord, unionBy, AiResponseError } from '../ai/client.js';
// ── Module-level abort tracker ─────────────────────────────────────────────────
let _reanalysisAbort = null;
export function isReanalysisRunning() {
    return _reanalysisAbort !== null;
}
export function abortReanalysis() {
    _reanalysisAbort?.abort();
}
const text = (v) => (typeof v === 'string' ? v.trim() : undefined);
/** Cleans a raw AI result; an unknown POS tag becomes 'phrase'. */
function _sanitise(raw) {
    const pos = text(raw.pos);
    const level = text(raw.level)?.toUpperCase();
    return {
        meaning: text(raw.meaning)?.slice(0, 200),
        level: level && CEFR_LEVELS.includes(level) ? level : undefined,
        base_form_verified: text(raw.base_form_verified),
        pos: pos === undefined ? undefined : POS_TAGS.includes(pos) ? pos : 'phrase',
        ipa: text(raw.ipa),
        collocations: Array.isArray(raw.collocations)
            ? raw.collocations
                .filter((c) => typeof c === 'string' && c.trim().length > 0)
                .map(c => c.trim().slice(0, 80))
                .slice(0, 4)
            : undefined,
    };
}
const snapshot = (e) => ({ pos: e.pos, ipa: e.ipa || undefined, collocations: JSON.stringify(e.collocations ?? []), base_form: e.base_form });
/**
 * Applies a cleaned result to the entry in place. Returns true if anything
 * changed. `asked`: the entry as the request saw it; a field changed since
 * (edited by the learner meanwhile) is left alone.
 */
function _applyResult(entry, result, originalWord, nativeLang, asked = snapshot(entry)) {
    let changed = false;
    const now = snapshot(entry);
    // Meaning and level are filled only when missing
    if (!entry.meaning?.trim() && result.meaning) {
        entry.meaning = result.meaning;
        entry.meaning_lang ??= nativeLang;
        changed = true;
    }
    if (!entry.level && result.level) {
        entry.level = result.level;
        changed = true;
    }
    if (result.pos && entry.pos !== result.pos && now.pos === asked.pos) {
        entry.pos = result.pos;
        changed = true;
    }
    // '' and undefined both mean "no IPA"; otherwise every run would count as a change
    const nextIpa = result.ipa || undefined;
    if (result.ipa !== undefined && nextIpa !== entry.ipa && now.ipa === asked.ipa) {
        entry.ipa = nextIpa;
        changed = true;
    }
    if (result.collocations && now.collocations === asked.collocations &&
        (result.collocations.length > 0 || (entry.collocations && entry.collocations.length > 0))) {
        const next = result.collocations.length > 0 ? result.collocations : undefined;
        if (JSON.stringify(entry.collocations) !== JSON.stringify(next)) {
            entry.collocations = next;
            changed = true;
        }
    }
    if (result.base_form_verified &&
        result.base_form_verified !== entry.base_form &&
        now.base_form === asked.base_form) {
        entry.base_form = result.base_form_verified;
        // The cached table was for the old base form
        entry.conj_cached = false;
        deleteConjCache(originalWord);
        changed = true;
    }
    return changed;
}
/** Which empty fields the AI should fill for an entry. */
const gaps = (e) => ({ needsMeaning: !e.meaning?.trim(), needsLevel: !e.level });
const BATCH_SIZE = 10;
/** Requests failing at the transport level (HTTP / network) this many times in a row stop the run. */
const MAX_REQUEST_FAILURES = 3;
/**
 * Replies unusable even after the client's retry (not JSON, refused, cut off) this many
 * times in a row stop the run: each one cost two paid requests, and a model or preset that
 * never answers in JSON would otherwise be asked about every word.
 */
const MAX_BAD_REPLIES = 4;
/** A bad reply is worth retrying word by word; a failed request (rate limit, auth, offline) is not. */
const isRequestFailure = (err) => !(err instanceof AiResponseError);
const acceptResult = (v) => (isRecord(v) ? _sanitise(v) : null);
const acceptBatch = (v) => {
    if (!Array.isArray(v))
        return null;
    const items = v.filter((r) => isRecord(r) && typeof r.word === 'string');
    return items.length ? items : null;
};
/** Applies results to the live wordbook (re-read, so concurrent edits survive); `asked`: each word as its request saw it. */
function applyAll(results, nativeLang, asked) {
    const wordbook = loadWordbook();
    const byWord = new Map(wordbook.map(e => [e.word, e]));
    let dirty = false;
    for (const { word, result } of results) {
        const entry = byWord.get(word);
        if (entry && _applyResult(entry, result, word, nativeLang, asked.get(word)))
            dirty = true;
    }
    if (dirty)
        saveWordbook(wordbook);
}
/** Re-analyses some or all of the wordbook. Reports through onProgress / onDone; the caller renders the UI. */
export async function runReanalysis(deps, options = {}) {
    _reanalysisAbort?.abort(); // only one run at a time
    const abort = new AbortController();
    _reanalysisAbort = abort;
    const { signal } = abort;
    const lang = deps.getLang();
    const nativeLang = deps.getNativeLang();
    const wanted = options.words ? new Set(options.words) : null;
    const pool = loadWordbook().filter(e => (wanted ? wanted.has(e.word) : e.level !== 'grammar' && e.level !== 'sentence'));
    const total = pool.length;
    let processed = 0;
    let failed = 0;
    const advance = (word, n = 1) => { processed += n; options.onProgress?.(processed, total, word); };
    // Stop instead of firing hundreds of doomed requests when the provider is down or rate-limiting,
    // or the model keeps answering with something that is not the JSON asked for
    let requestFailures = 0;
    let badReplies = 0;
    let fatal;
    const succeeded = () => { requestFailures = 0; badReplies = 0; };
    const stop = (message) => { fatal = message; abort.abort(); };
    const recordFailure = (err) => {
        if (signal.aborted)
            return;
        const message = err instanceof Error ? err.message : String(err);
        if (isRequestFailure(err) ? ++requestFailures >= MAX_REQUEST_FAILURES : ++badReplies >= MAX_BAD_REPLIES)
            stop(message);
    };
    const analyseOne = async (entry) => {
        const asked = new Map([[entry.word, snapshot(entry)]]);
        try {
            const { data, partial } = await deps.ai.json({
                prompt: reanalysisPrompt(entry.word, entry.base_form, lang, nativeLang, gaps(entry)),
                signal,
                accept: acceptResult,
            });
            if (partial) {
                console.warn('[Polyglot] reanalysis reply was cut off; not applied for', entry.word);
                failed++;
                if (++badReplies >= MAX_BAD_REPLIES)
                    stop('the replies were cut off (raise the max tokens)');
                return;
            }
            succeeded();
            applyAll([{ word: entry.word, result: data }], nativeLang, asked);
        }
        catch (err) {
            if (signal.aborted)
                return;
            console.warn('[Polyglot] reanalysis failed for', entry.word, err);
            failed++;
            recordFailure(err);
        }
    };
    try {
        for (let i = 0; i < pool.length && !signal.aborted; i += BATCH_SIZE) {
            const batch = pool.slice(i, i + BATCH_SIZE);
            options.onProgress?.(processed, total, batch[0].word);
            let answered = new Set();
            const asked = new Map(batch.map(e => [e.word, snapshot(e)]));
            try {
                const { data, partial } = await deps.ai.json({
                    prompt: batchReanalysisPrompt(batch.map(e => ({ word: e.word, base_form: e.base_form, ...gaps(e) })), lang, nativeLang),
                    signal,
                    accept: acceptBatch,
                    merge: unionBy(r => r.word),
                });
                if (!partial)
                    succeeded();
                // A cut-off reply's last item may be half-written, and which one is last is unknown after merging
                if (!partial) {
                    // Only the words asked about: a reply may name others (an echo slip, or text in an imported entry)
                    const items = data.filter(r => asked.has(r.word));
                    applyAll(items.map(r => ({ word: r.word, result: _sanitise(r) })), nativeLang, asked);
                    answered = new Set(items.map(r => r.word));
                }
            }
            catch (err) {
                if (signal.aborted)
                    break;
                recordFailure(err);
                if (signal.aborted)
                    break;
                console.warn('[Polyglot] reanalysis batch failed — retrying word by word', err);
            }
            const done = batch.filter(e => answered.has(e.word));
            if (done.length)
                advance(done[done.length - 1].word, done.length);
            for (const entry of batch.filter(e => !answered.has(e.word))) {
                if (signal.aborted)
                    break;
                await analyseOne(entry);
                advance(entry.word);
            }
        }
    }
    finally {
        if (_reanalysisAbort === abort)
            _reanalysisAbort = null;
        options.onDone?.(processed, total, signal.aborted, fatal, failed);
    }
}
