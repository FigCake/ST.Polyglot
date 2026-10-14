// What the wordbook gives quizzes to work with, instead of the chat (which
// only the chat quizzes and the chat-scene writing task send):
//
//   studyWords(pool)     10–20 random words being studied (new or learning; known left out)
//   grammarItems(pool)   saved grammar patterns, at random
//   studyVerbs(pool)     verbs being studied, at random
//   relearn(pool, words) words missed in a quiz are due today (their next review comes now)
//
// A quiz with too little to work with (fewer than ENOUGH_WORDS words…) asks
// for general questions at the learner's level instead.
//
// Pure: takes the entries, changes only those given to relearn.
import { isCard, isKnown, isNew } from './srs.js';
import { shuffleArray } from './utils.js';
/** Words a quiz picks: a random number in this range (fewer when the wordbook has fewer). */
export const QUIZ_WORDS = { min: 10, max: 20 };
/** Fewer words than this: general questions at the learner's level instead. */
export const ENOUGH_WORDS = 5;
/** Grammar patterns and verbs a quiz is built on, at most. */
export const QUIZ_GRAMMAR = 5;
export const QUIZ_VERBS = 3;
const beingStudied = (e) => isCard(e) && !isKnown(e);
const asWord = (e) => ({ word: e.word, meaning: e.meaning ?? '' });
const pick = (list, n) => shuffleArray(list).slice(0, n);
/** 10–20 random words (and saved idioms) being studied; known words, grammar and sentences left out. */
export function studyWords(pool, random = Math.random) {
    const count = QUIZ_WORDS.min + Math.floor(random() * (QUIZ_WORDS.max - QUIZ_WORDS.min + 1));
    return pick(pool.filter(beingStudied), count).map(asWord);
}
/** Saved grammar patterns, at random. */
export function grammarItems(pool, count = QUIZ_GRAMMAR) {
    return pick(pool.filter(e => e.level === 'grammar' && e.word.trim()), count).map(e => ({ pattern: e.word, meaning: e.meaning ?? '' }));
}
/** Verbs being studied, at random (by base form). */
export function studyVerbs(pool, count = QUIZ_VERBS) {
    return pick(pool.filter(e => e.pos === 'verb' && isCard(e) && !isKnown(e)), count)
        .map(e => ({ word: e.base_form?.trim() || e.word, meaning: e.meaning ?? '' }));
}
const key = (s) => (s ?? '').normalize('NFKC').toLowerCase().trim();
/**
 * Words missed in a quiz come back today: a word being learnt is due now
 * (a new word is reviewed soon anyway, a known one is left alone). Matched by
 * word or base form. Returns the entries changed.
 */
export function relearn(pool, words, now = Date.now()) {
    const byKey = new Map();
    for (const e of pool) {
        if (!isCard(e))
            continue;
        for (const k of [key(e.word), key(e.base_form)])
            if (k && !byKey.has(k))
                byKey.set(k, e);
    }
    const changed = new Set();
    for (const w of words) {
        const e = byKey.get(key(w));
        if (!e || isNew(e) || isKnown(e) || (e.srs_due ?? Infinity) <= now)
            continue;
        e.srs_due = now;
        changed.add(e);
    }
    return [...changed];
}
