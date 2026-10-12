// Spaced repetition with FSRS-6 (open-spaced-repetition): the long-term
// scheduler — whole days, no learning steps — computed as ts-fsrs does with
// short-term scheduling off (srs.test.ts checks it against ts-fsrs).
// Pure: no DOM, no I/O.
//
//   srsRate(entry, rating)       schedules a word after a rating
//   previewDays(entry)           the days each rating would give (button labels)
//   todaysCards(pool, newLeft)   due reviews first, then new words up to the day's limit
//   forecast(pool)               reviews due tomorrow and in the coming week (dueAhead: per day)
//   isMissed(entry)              a frequently missed word (forgotten often, not known yet)
//
// A word's memory is its stability (days until the chance of recalling it
// falls to 90%) and difficulty (1–10). Words reviewed with the old SM-2
// schedule get theirs from interval and ease at their next review, the way
// Anki converts them. A word never reviewed is new.
//
// Days begin at 4 AM local time, so a late-night session counts for the day
// before; a review is due from the start of its day.
/** FSRS-6 default parameters. */
const W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
    1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const RETENTION = 0.9;
const MAX_INTERVAL = 36500;
const S_MIN = 0.001;
const DAY_MS = 86_400_000;
const DAY_START_HOUR = 4;
/** ts-fsrs rounds every step to 8 decimals; so do we, so the two agree exactly. */
const round8 = (n) => Math.round(n * 1e8) / 1e8;
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
const DECAY = -W[20];
const FACTOR = round8(Math.exp(Math.log(0.9) / DECAY) - 1);
const MODIFIER = round8((Math.pow(RETENTION, 1 / DECAY) - 1) / FACTOR);
// ── Memory model ──────────────────────────────────────────────────────────────
/** The chance of recalling a word `days` after its last review. */
export const retrievability = (days, stability) => round8(Math.pow(1 + FACTOR * days / stability, DECAY));
const initStability = (g) => Math.max(W[g - 1], 0.1);
const initDifficulty = (g) => round8(W[4] - Math.exp((g - 1) * W[5]) + 1);
function nextDifficulty(d, g) {
    const next = d + round8(-W[6] * (g - 3) * (10 - d) / 9);
    return clamp(round8(W[7] * initDifficulty(4) + (1 - W[7]) * next), 1, 10);
}
function recallStability(d, s, r, g) {
    const hard = g === 2 ? W[15] : 1;
    const easy = g === 4 ? W[16] : 1;
    return round8(clamp(s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy), S_MIN, MAX_INTERVAL));
}
function forgetStability(d, s, r) {
    return round8(clamp(W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]), S_MIN, MAX_INTERVAL));
}
/** The memory after a review `days` after the last one (null: a new word). */
function nextMemory(m, days, g) {
    if (!m)
        return { difficulty: clamp(initDifficulty(g), 1, 10), stability: initStability(g) };
    const r = retrievability(days, m.stability);
    const stability = g === 1
        ? clamp(round8(m.stability), S_MIN, forgetStability(m.difficulty, m.stability, r))
        : recallStability(m.difficulty, m.stability, r, g);
    return { difficulty: nextDifficulty(m.difficulty, g), stability };
}
// ── Intervals ─────────────────────────────────────────────────────────────────
/** How far a long interval may be moved, so words learnt together do not stay due together. */
function fuzzRange(interval, elapsed) {
    let delta = 1;
    for (const [start, end, factor] of [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]]) {
        delta += factor * Math.max(Math.min(interval, end) - start, 0);
    }
    interval = Math.min(interval, MAX_INTERVAL);
    let min = Math.max(2, Math.round(interval - delta));
    const max = Math.min(Math.round(interval + delta), MAX_INTERVAL);
    if (interval > elapsed)
        min = Math.max(min, elapsed + 1);
    return { min: Math.min(min, max), max };
}
function interval(stability, elapsed, fuzz) {
    const days = Math.min(Math.max(1, Math.round(stability * MODIFIER)), MAX_INTERVAL);
    if (fuzz === null || days < 2.5)
        return days;
    const { min, max } = fuzzRange(days, elapsed);
    return Math.floor(fuzz * (max - min + 1) + min);
}
/**
 * What each rating (Again, Hard, Good, Easy) does to a memory reviewed
 * `elapsed` days after the last review. Intervals keep Again ≤ Hard < Good < Easy.
 * `fuzz` (0–1) spreads long intervals; null for none.
 */
export function schedule(m, elapsed, fuzz) {
    const t = m ? elapsed : 0;
    const memories = [1, 2, 3, 4].map(g => nextMemory(m, t, g));
    const [a0, h0, g0, e0] = memories.map(x => interval(x.stability, t, fuzz));
    const a = Math.min(a0, h0);
    const h = Math.max(h0, a + 1);
    const g = Math.max(g0, h + 1);
    const e = Math.max(e0, g + 1);
    return [a, h, g, e].map((days, i) => ({ memory: memories[i], days }));
}
// ── Days ──────────────────────────────────────────────────────────────────────
/** The study day of a moment, as a day number (days begin at 4 AM local time). */
export function studyDay(ms) {
    // By the local clock, not ms − 4 h: on a daylight-saving change the two differ by an hour
    const d = new Date(ms);
    if (d.getHours() < DAY_START_HOUR)
        d.setDate(d.getDate() - 1);
    return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}
/** When a study day begins. */
export function dayStart(day) {
    const u = new Date(day * DAY_MS);
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), DAY_START_HOUR).getTime();
}
/** A study day as YYYY-MM-DD. */
export const dayKey = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
// ── Words ─────────────────────────────────────────────────────────────────────
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** Stability and difficulty for a word reviewed with SM-2 (fsrs-rs memory_state_from_sm2, SM-2 retention 90%). */
function fromSm2(ease, sm2Interval) {
    const stability = Math.max(sm2Interval, S_MIN) * FACTOR / (Math.pow(0.9, 1 / DECAY) - 1);
    const difficulty = 11 - (ease - 1) / (Math.exp(W[8]) * Math.pow(stability, -W[9]) * Math.expm1(0.1 * W[10]));
    return { stability: clamp(stability, S_MIN, MAX_INTERVAL), difficulty: clamp(difficulty, 1, 10) };
}
/** The word's memory; null for a word never reviewed. */
export function memoryOf(e) {
    if (finite(e.srs_stability) && finite(e.srs_difficulty)) {
        return { stability: clamp(e.srs_stability, S_MIN, MAX_INTERVAL), difficulty: clamp(e.srs_difficulty, 1, 10) };
    }
    if (!finite(e.srs_reviewed_at))
        return null;
    return fromSm2(finite(e.srs_ease) ? e.srs_ease : 2.5, finite(e.srs_interval) ? e.srs_interval : 1);
}
export const isNew = (e) => memoryOf(e) === null;
/** Grammar patterns and sentences are review material for quizzes, not cards. */
export const isCard = (w) => w.level !== 'grammar' && w.level !== 'sentence';
/** A word counts as known once it would be recalled for three weeks (stability in days). */
export const KNOWN_STABILITY = 21;
/** Times forgotten (at most once a day) that make a word frequently missed. */
export const MISSED_LAPSES = 4;
/** Known: marked so by the learner, or recalled for three weeks. */
export const isKnown = (e) => e.known === true || (memoryOf(e)?.stability ?? 0) >= KNOWN_STABILITY;
/** A new word waiting for its first review (one marked known is not). */
export const isFresh = (e) => isNew(e) && e.known !== true;
/** New (never reviewed), learning, or known. */
export const wordStatus = (e) => (isKnown(e) ? 'known' : isNew(e) ? 'new' : 'learning');
/** Forgotten MISSED_LAPSES times or more and not known yet: worth extra practice. */
export const isMissed = (e) => (e.srs_lapses ?? 0) >= MISSED_LAPSES && !isKnown(e);
const daysSince = (at, now) => (finite(at) ? Math.max(0, studyDay(now) - studyDay(at)) : 0);
/** A fixed 0–1 value per word and review, so the labels show the interval a rating then gives. */
function fuzzFor(e) {
    const seed = `${e.word}|${e.srs_reviewed_at ?? 0}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++)
        h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
    return (h >>> 0) / 2 ** 32;
}
const stepsFor = (e, now) => schedule(memoryOf(e), daysSince(e.srs_reviewed_at, now), fuzzFor(e));
/** The days until the next review each rating (Again … Easy) would give. */
export const previewDays = (e, now = Date.now()) => stepsFor(e, now).map(s => s.days);
/** Schedules a word after a rating (0 Again · 1 Hard · 2 Good · 3 Easy), in place. */
export function srsRate(e, rating, now = Date.now()) {
    const wasNew = isNew(e);
    const step = stepsFor(e, now)[rating];
    // A word forgotten again in the same session is one lapse
    if (rating === 0 && !wasNew && daysSince(e.srs_reviewed_at, now) > 0)
        e.srs_lapses = (e.srs_lapses ?? 0) + 1;
    e.srs_stability = step.memory.stability;
    e.srs_difficulty = step.memory.difficulty;
    e.srs_due = dayStart(studyDay(now) + step.days);
    e.srs_reviewed_at = now;
    delete e.srs_interval;
    delete e.srs_ease;
    delete e.srs_streak;
    return { requeue: rating === 0, wasNew };
}
/** Words in the review schedule: reviewed before and not marked known. */
const scheduled = (e) => !isNew(e) && e.known !== true;
const isDue = (e, now) => scheduled(e) && (e.srs_due ?? 0) <= now;
/** Reviews due now (new words and words marked known aside). */
export const dueCount = (pool, now = Date.now()) => pool.filter(e => isDue(e, now)).length;
/** Today's cards: due reviews, most overdue first, then up to `newLeft` new words in the order they were added. */
export function todaysCards(pool, newLeft, now = Date.now()) {
    const due = pool.filter(e => isDue(e, now)).sort((a, b) => (a.srs_due ?? 0) - (b.srs_due ?? 0));
    const fresh = pool.filter(isFresh).sort((a, b) => (a.dateAdded ?? '').localeCompare(b.dateAdded ?? ''));
    return [...due, ...fresh.slice(0, Math.max(0, newLeft))];
}
/** Reviews due on each of the `days` days after today. */
export function dueAhead(pool, days, now = Date.now()) {
    const today = studyDay(now);
    const out = new Array(days).fill(0);
    for (const e of pool) {
        if (!scheduled(e))
            continue;
        const ahead = studyDay(e.srs_due ?? 0) - today;
        if (ahead >= 1 && ahead <= days)
            out[ahead - 1]++;
    }
    return out;
}
/** Reviews due tomorrow, and in the seven days after today. */
export function forecast(pool, now = Date.now()) {
    const week = dueAhead(pool, 7, now);
    return { tomorrow: week[0], week: week.reduce((a, b) => a + b, 0) };
}
