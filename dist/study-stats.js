// What the study record (Learn tab, before a mode is picked) shows, from the
// day totals (user-data StudyDay) and the words. Pure: no DOM, no I/O.
import { studyDay, dayKey, dueCount, dueAhead, isKnown } from './srs.js';
const DAY_MS = 86_400_000;
const dayOf = (key) => Math.round(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / DAY_MS);
const studied = (d) => d.n + d.r > 0;
export function studyStats(days, pool, now = Date.now()) {
    const today = studyDay(now);
    const byDay = new Map(days.map(d => [dayOf(d.d), d]));
    const active = new Set([...byDay].filter(([, d]) => studied(d)).map(([day]) => day));
    const studiedToday = active.has(today);
    let streak = 0;
    for (let day = studiedToday ? today : today - 1; active.has(day); day--)
        streak++;
    let best = 0, run = 0, prev = NaN;
    for (const day of [...active].sort((a, b) => a - b)) {
        run = day === prev + 1 ? run + 1 : 1;
        best = Math.max(best, run);
        prev = day;
    }
    let ratings30 = 0, again30 = 0;
    for (let day = today - 29; day <= today; day++) {
        const d = byDay.get(day);
        if (d) {
            ratings30 += d.n + d.r;
            again30 += d.a;
        }
    }
    return {
        streak, best, studiedToday,
        day: today,
        counts: new Map([...byDay].filter(([, d]) => studied(d)).map(([day, d]) => [day, d.n + d.r])),
        today: byDay.get(today) ?? { d: dayKey(today), n: 0, r: 0, a: 0 },
        accuracy: ratings30 ? Math.max(0, 1 - again30 / ratings30) : null,
        ratings30,
        ahead: dueAhead(pool, 7, now),
        words: pool.length,
        known: pool.filter(isKnown).length,
        due: dueCount(pool, now),
    };
}
