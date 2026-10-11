// SM-2 spaced-repetition algorithm. Pure functions: no side effects, no DOM, no API calls.
import { SRS as SRS_CFG } from './constants.js';
/**
 * Days until the next review for a rating (0 = due again now). Good always
 * adds at least a day and Easy at least a day more than Good: with a low ease
 * (after lapses) rounding would otherwise keep a card at 1 day forever.
 */
function nextInterval(interval, ease, rating) {
    if (rating === 0)
        return 0;
    if (rating === 1)
        return Math.max(1, Math.round(interval * SRS_CFG.hardIntervalMult));
    const good = Math.max(interval + 1, Math.round(interval * ease));
    return rating === 2 ? good : Math.max(good + 1, Math.round(interval * ease * SRS_CFG.easyIntervalBonus));
}
/** Updates the entry's schedule in place (0=Again 1=Hard 2=Good 3=Easy). True = re-queue this session. */
export function srsRate(entry, rating) {
    let interval = entry.srs_interval ?? SRS_CFG.initialInterval;
    let ease = entry.srs_ease ?? SRS_CFG.defaultEase;
    const requeue = rating === 0;
    if (rating === 0) { // Again — re-queue at end of session, start over at 1 day
        interval = 1;
        ease = Math.max(SRS_CFG.minEase, ease + SRS_CFG.againEaseDelta);
    }
    else {
        interval = nextInterval(interval, ease, rating);
        if (rating === 1)
            ease = Math.max(SRS_CFG.minEase, ease + SRS_CFG.hardEaseDelta);
        if (rating === 3)
            ease = Math.min(4.0, ease + 0.15);
    }
    entry.srs_interval = interval;
    entry.srs_ease = parseFloat(ease.toFixed(2));
    entry.srs_due = Date.now() + (requeue ? 0 : interval * SRS_CFG.dayMs);
    entry.srs_reviewed_at = Date.now();
    return requeue;
}
export function srsDueCount(pool) {
    const now = Date.now();
    return pool.filter(w => (w.srs_due ?? 0) <= now).length;
}
/** The label ("today", "tomorrow", "in 3d") shown above a rating button; the same schedule srsRate sets. */
export function srsPreview(interval, ease, rating) {
    const days = nextInterval(interval, ease, rating);
    if (days <= 0)
        return 'today';
    if (days === 1)
        return 'tomorrow';
    return `in ${days}d`;
}
