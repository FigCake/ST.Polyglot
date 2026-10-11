// Study totals per day (user-data StudyDay), counted as words are reviewed.
import { daysData, replaceUserData } from './data-store.js';
import { dayKey, studyDay } from './srs.js';
const today = (now) => dayKey(studyDay(now));
/** Counts one review: a new word's first, or a learnt word's; and whether it was forgotten. */
export function logReview(review, now = Date.now()) {
    const d = today(now);
    const days = daysData();
    const day = days.find(x => x.d === d) ?? { d, n: 0, r: 0, a: 0 };
    const next = {
        d,
        n: day.n + (review.wasNew ? 1 : 0),
        r: day.r + (review.wasNew ? 0 : 1),
        a: day.a + (review.forgot ? 1 : 0),
    };
    replaceUserData({ days: [...days.filter(x => x.d !== d), next] });
}
/** New words started today. */
export const newWordsToday = (now = Date.now()) => daysData().find(x => x.d === today(now))?.n ?? 0;
