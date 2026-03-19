// ════════════════════════════
// Polyglot  srs.ts
// ════════════════════════════
// SM-2 spaced-repetition algorithm.
// Pure functions — no side effects, no DOM, no API calls.
// Dependencies: constants.ts, types.ts only.
import { SRS as SRS_CFG } from './constants.js';
/**
 * Updates the SRS schedule for a wordbook entry in-place.
 * @param entry   Wordbook entry
 * @param rating  0=Again 1=Hard 2=Good 3=Easy
 * @returns true if the card should be re-queued this session (Again)
 */
export function srsRate(entry, rating) {
    let interval = entry.srs_interval ?? SRS_CFG.initialInterval;
    let ease = entry.srs_ease ?? SRS_CFG.defaultEase;
    let requeue = false;
    if (rating === 0) { // Again — re-queue at end of session
        interval = 1;
        ease = Math.max(SRS_CFG.minEase, ease + SRS_CFG.againEaseDelta);
        requeue = true;
    }
    else if (rating === 1) { // Hard — shorter interval, slight ease decrease
        interval = Math.max(1, Math.round(interval * SRS_CFG.hardIntervalMult));
        ease = Math.max(SRS_CFG.minEase, ease + SRS_CFG.hardEaseDelta);
    }
    else if (rating === 2) { // Good — normal interval
        interval = Math.max(1, Math.round(interval * ease));
    }
    else { // Easy — longer interval, slight ease increase
        interval = Math.max(1, Math.round(interval * ease * SRS_CFG.easyIntervalBonus));
        ease = Math.min(4.0, ease + 0.15);
    }
    entry.srs_interval = interval;
    entry.srs_ease = parseFloat(ease.toFixed(2));
    entry.srs_due = Date.now() + (requeue ? 0 : interval * SRS_CFG.dayMs);
    entry.srs_reviewed_at = Date.now();
    return requeue;
}
/** Returns the number of due cards in the given pool. */
export function srsDueCount(pool) {
    const now = Date.now();
    return pool.filter(w => (w.srs_due ?? 0) <= now).length;
}
/** Returns a preview string like "in N days" shown above SRS rating buttons. */
export function srsPreview(interval, ease, rating) {
    let days;
    if (rating === 0)
        days = 1;
    else if (rating === 1)
        days = Math.max(1, Math.round(interval * SRS_CFG.hardIntervalMult));
    else if (rating === 2)
        days = Math.max(1, Math.round(interval * ease));
    else
        days = Math.max(1, Math.round(interval * ease * SRS_CFG.easyIntervalBonus));
    if (days <= 0)
        return 'today';
    if (days === 1)
        return 'tomorrow';
    return `in ${days}d`;
}
