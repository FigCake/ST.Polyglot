// ════════════════════════════
// Polyglot  features/reanalysis.ts
// ════════════════════════════
// AI batch re-analysis — enriches existing wordbook entries with
// pos, ipa, collocations, and a verified base_form.
//
// Design rules:
//   • Pure feature module — no direct ST state reads.
//     All deps (callModel, getLang, getNativeLang) injected via ReanalysisDeps.
//   • Processes words one-by-one (sequential, not parallel) to stay within
//     rate limits and give the user smooth progress feedback.
//   • Only overwrites: pos, ipa, collocations, base_form (if corrected).
//     Never touches: meaning, notes, srs_*, setIds, dateAdded, example*.
//   • When base_form changes, conj_cached is reset to false so stale
//     conjugation tables are not shown for the new base form.
//   • AbortController allows the user to stop mid-batch at any time.
//   • On abort or error the wordbook is saved with whatever was completed.
//
// Dependencies: constants.ts, types.ts, prompts.ts, utils.ts,
//               wordbook.ts, conj-cache.ts
import { API, POS_TAGS } from '../constants.js';
import { reanalysisPrompt, batchReanalysisPrompt } from '../prompts.js';
import { parseJSON } from '../utils.js';
import { loadWordbook, saveWordbook } from '../wordbook.js';
import { deleteConjCache } from '../conj-cache.js';
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
    return {
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
function _applyResult(entry, result, originalWord) {
    let changed = false;
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
// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Runs AI re-analysis on a subset (or all) of the wordbook, one word at a time.
 *
 * Progress is reported via onProgress; completion via onDone.
 * The caller is responsible for rendering the progress UI.
 *
 * @returns AbortController so the caller can wire up a Stop button.
 */
export async function runReanalysis(deps, options = {}) {
    // Only one run at a time
    if (_reanalysisAbort)
        _reanalysisAbort.abort();
    const abort = new AbortController();
    _reanalysisAbort = abort;
    const { signal } = abort;
    const lang = deps.getLang();
    const nativeLang = deps.getNativeLang();
    // Snapshot the wordbook at run start — reloaded fresh after each write
    const wb = loadWordbook();
    const pool = options.words
        ? wb.filter(e => options.words?.includes(e.word) ?? false)
        : wb.filter(e => e.level !== 'grammar' && e.level !== 'sentence');
    const total = pool.length;
    let processed = 0;
    // ── Batch size: 10 words per API call (falls back to 1 on parse error) ──
    const BATCH = 10;
    try {
        for (let i = 0; i < pool.length; i += BATCH) {
            if (signal.aborted)
                break;
            const batch = pool.slice(i, i + BATCH);
            // Report start of batch
            options.onProgress?.(processed, total, batch[0].word);
            try {
                const raw = await deps.callModel(API.sysJson, batchReanalysisPrompt(batch, lang, nativeLang), signal);
                if (signal.aborted)
                    break;
                // Parse array response — fall back to single-word calls if malformed
                let results = null;
                try {
                    const parsed = parseJSON(raw);
                    if (Array.isArray(parsed)) {
                        results = parsed;
                    }
                }
                catch {
                    results = null;
                }
                if (results) {
                    // ── Apply batch results
                    const liveWb = loadWordbook();
                    let dirty = false;
                    for (const result of results) {
                        const entry = liveWb.find(e => e.word === result.word);
                        if (entry) {
                            const changed = _applyResult(entry, _sanitise(result), result.word);
                            if (changed)
                                dirty = true;
                        }
                    }
                    if (dirty)
                        saveWordbook(liveWb);
                    processed += batch.length;
                }
                else {
                    // ── Fallback: process batch words one-by-one
                    for (const entry of batch) {
                        if (signal.aborted)
                            break;
                        try {
                            const singleRaw = await deps.callModel(API.sysJson, reanalysisPrompt(entry.word, entry.base_form, lang, nativeLang), signal);
                            if (signal.aborted)
                                break;
                            const result = _sanitise(parseJSON(singleRaw));
                            const liveWb = loadWordbook();
                            const liveEntry = liveWb.find(e => e.word === entry.word);
                            if (liveEntry) {
                                const changed = _applyResult(liveEntry, result, entry.word);
                                if (changed)
                                    saveWordbook(liveWb);
                            }
                        }
                        catch (err) {
                            if (signal.aborted)
                                break;
                            console.warn('[Polyglot] reanalysis fallback: failed for', entry.word, err);
                        }
                        processed++;
                        options.onProgress?.(processed, total, entry.word);
                    }
                    continue; // progress already reported per-word above
                }
            }
            catch (err) {
                if (signal.aborted)
                    break;
                console.warn('[Polyglot] reanalysis: batch failed at index', i, err);
                processed += batch.length; // count as processed even on error
            }
            options.onProgress?.(processed, total, batch[batch.length - 1].word);
        }
    }
    finally {
        const aborted = signal.aborted;
        _reanalysisAbort = null;
        options.onDone?.(processed, total, aborted);
    }
}
