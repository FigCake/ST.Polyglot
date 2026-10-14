// Study totals per day (user-data StudyDay): words reviewed (flashcards), and
// everything else studied (quizzes, writing, dictation, shadowing, matching,
// checked messages), so the streak and today's count include all of it.
import { daysData, replaceUserData } from './data-store.js';
import { dayKey, studyDay } from './srs.js';
const today = (now) => dayKey(studyDay(now));
/**
 * Counts one review: a new word's first, or a learnt word's; and whether it was
 * forgotten. `burst`: one of a review session's, saved with the others (data-store commit).
 */
export function logReview(review, burst = false, now = Date.now()) {
    const d = today(now);
    const days = daysData();
    const day = days.find(x => x.d === d) ?? { d, n: 0, r: 0, a: 0 };
    const next = {
        ...day,
        n: day.n + (review.wasNew ? 1 : 0),
        r: day.r + (review.wasNew ? 0 : 1),
        a: day.a + (review.forgot ? 1 : 0),
    };
    replaceUserData({ days: [...days.filter(x => x.d !== d), next] }, burst);
}
/**
 * Counts other study done today: a quiz or exam answer, a piece of writing
 * rated, a dictation or shadowing try, a matched pair, a checked message.
 * Saved with the next save (one of many in a row: data-store commit burst).
 */
export function logStudy(count = 1, now = Date.now()) {
    const d = today(now);
    const days = daysData();
    const day = days.find(x => x.d === d) ?? { d, n: 0, r: 0, a: 0 };
    replaceUserData({ days: [...days.filter(x => x.d !== d), { ...day, o: (day.o ?? 0) + count }] }, true);
}
/** New words started today. */
export const newWordsToday = (now = Date.now()) => daysData().find(x => x.d === today(now))?.n ?? 0;
