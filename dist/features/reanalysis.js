// ════════════════════════════
// Polyglot  features/reanalysis.ts
// ════════════════════════════
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
//   • AbortController allows the user to stop mid-batch at any time.
//   • On abort or error the wordbook is saved with whatever was completed.
//
// Dependencies: constants.ts, types.ts, prompts.ts, utils.ts,
//               wordbook.ts, conj-cache.ts
import { POS_TAGS, CEFR_LEVELS } from '../constants.js';
import { reanalysisPrompt, batchReanalysisPrompt } from '../prompts.js';
import { loadWordbook, saveWordbook } from '../wordbook.js';
import { deleteConjCache } from '../conj-cache.js';
import { isRecord, unionBy, AiResponseError } from '../ai/client.js';
// ── Module-level abort tracker ─────────────────────────────────────────────────
// Only one reanalysis run can be active at a time.
let _reanalysisAbort = null;
/** True while a reanalysis run is in progress. */
export function isReanalysisRunning() {
    return _reanalysisAbort !== null;
}
/** Aborts the current run if one is active. */
export function abortReanalysis() {
    _reanalysisAbort?.abort();
}
// ── Internal helpers ───────────────────────────────────────────────────────────
/**
 * Validates and sanitises a raw AI response into a safe ReanalysisResult.
 * Unknown pos tags are coerced to 'phrase' to avoid storing garbage values.
 */
function _sanitise(raw) {
    const pos = POS_TAGS.includes(raw.pos)
        ? raw.pos
        : 'phrase';
    const level = String(raw.level ?? '').trim().toUpperCase();
    return {
        meaning: typeof raw.meaning === 'string' ? raw.meaning.trim().slice(0, 200) : '',
        level: CEFR_LEVELS.includes(level) ? level : '',
        base_form_verified: (raw.base_form_verified ?? '').trim() || '',
        pos,
        pos_label: (raw.pos_label ?? '').trim(),
        ipa: (raw.ipa ?? '').trim(),
        collocations: Array.isArray(raw.collocations)
            ? raw.collocations
                .filter((c) => typeof c === 'string' && c.trim().length > 0)
                .map(c => c.trim().slice(0, 80)) // hard cap per item
                .slice(0, 4) // max 4 items
            : [],
    };
}
/**
 * Applies a sanitised ReanalysisResult to a WordbookEntry in-place.
 * Returns true if any field actually changed (for dirty-tracking).
 */
function _applyResult(entry, result, originalWord, nativeLang) {
    let changed = false;
    // meaning / level — filled only when missing
    if (!entry.meaning?.trim() && result.meaning) {
        entry.meaning = result.meaning;
        entry.meaning_lang ??= nativeLang;
        changed = true;
    }
    if (!entry.level && result.level) {
        entry.level = result.level;
        changed = true;
    }
    // pos
    if (result.pos && entry.pos !== result.pos) {
        entry.pos = result.pos;
        changed = true;
    }
    // ipa — treat empty string and undefined as equivalent (both mean "no IPA").
    // Comparing directly avoids a false positive where result.ipa='' and
    // entry.ipa=undefined would repeatedly trigger changed=true on every run.
    const nextIpa = result.ipa || undefined;
    if (nextIpa !== entry.ipa) {
        entry.ipa = nextIpa;
        changed = true;
    }
    // collocations
    if (result.collocations.length > 0 ||
        (entry.collocations && entry.collocations.length > 0)) {
        const next = result.collocations.length > 0 ? result.collocations : undefined;
        if (JSON.stringify(entry.collocations) !== JSON.stringify(next)) {
            entry.collocations = next;
            changed = true;
        }
    }
    // base_form — only update if the AI returned something non-empty and different
    if (result.base_form_verified &&
        result.base_form_verified !== entry.base_form) {
        entry.base_form = result.base_form_verified;
        // Invalidate conjugation cache — the base form changed
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
/** A bad reply is worth retrying word by word; a failed request (rate limit, auth, offline) is not. */
const isRequestFailure = (err) => !(err instanceof AiResponseError);
const acceptResult = (v) => (isRecord(v) ? _sanitise(v) : null);
const acceptBatch = (v) => {
    if (!Array.isArray(v))
        return null;
    const items = v.filter((r) => isRecord(r) && typeof r.word === 'string');
    return items.length ? items : null;
};
/** Applies results to the live wordbook (re-read, so concurrent edits survive). */
function applyAll(results, nativeLang) {
    const wordbook = loadWordbook();
    const byWord = new Map(wordbook.map(e => [e.word, e]));
    let dirty = false;
    for (const { word, result } of results) {
        const entry = byWord.get(word);
        if (entry && _applyResult(entry, result, word, nativeLang))
            dirty = true;
    }
    if (dirty)
        saveWordbook(wordbook);
}
/**
 * Runs AI re-analysis on a subset (or all) of the wordbook.
 * Progress is reported via onProgress, completion via onDone; the caller renders the UI.
 */
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
    const advance = (word, n = 1) => { processed += n; options.onProgress?.(processed, total, word); };
    // Stop instead of firing hundreds of doomed requests when the provider is down or rate-limiting
    let failures = 0;
    let fatal;
    const recordFailure = (err) => {
        if (signal.aborted || !isRequestFailure(err))
            return;
        if (++failures >= MAX_REQUEST_FAILURES) {
            fatal = err instanceof Error ? err.message : String(err);
            abort.abort();
        }
    };
    const analyseOne = async (entry) => {
        try {
            const { data } = await deps.ai.json({
                prompt: reanalysisPrompt(entry.word, entry.base_form, lang, nativeLang, gaps(entry)),
                signal,
                accept: acceptResult,
            });
            failures = 0;
            applyAll([{ word: entry.word, result: data }], nativeLang);
        }
        catch (err) {
            if (!signal.aborted)
                console.warn('[Polyglot] reanalysis failed for', entry.word, err);
            recordFailure(err);
        }
    };
    try {
        for (let i = 0; i < pool.length && !signal.aborted; i += BATCH_SIZE) {
            const batch = pool.slice(i, i + BATCH_SIZE);
            options.onProgress?.(processed, total, batch[0].word);
            let answered = new Set();
            try {
                const { data } = await deps.ai.json({
                    prompt: batchReanalysisPrompt(batch.map(e => ({ word: e.word, base_form: e.base_form, ...gaps(e) })), lang, nativeLang),
                    signal,
                    accept: acceptBatch,
                    merge: unionBy(r => r.word),
                });
                failures = 0;
                applyAll(data.map(r => ({ word: r.word, result: _sanitise(r) })), nativeLang);
                answered = new Set(data.map(r => r.word));
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
        options.onDone?.(processed, total, signal.aborted, fatal);
    }
}
