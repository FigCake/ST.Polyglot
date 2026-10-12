// The study record: what the Learn tab shows before a word or mode is picked.
//
//   10 day streak · best 12
//   this month: days studied in a soft band, runs joined, today ringed
//   today · to review (a tap starts the review) · accuracy · known words
//   reviews due on each of the next 7 days
//
// Numbers come from study-stats.ts; colors are one translucent hue per panel
// theme (style-features.css).
import { html, setHtml, raw } from '../../html.js';
import { t } from '../../i18n.js';
import { getSettings } from '../../runtime.js';
import { daysData } from '../../data-store.js';
import { scopedWordbook } from '../../wordbook.js';
import { isFresh, isCard } from '../../srs.js';
import { studyStats } from '../../study-stats.js';
const DAY_MS = 86_400_000;
const dateOf = (day) => new Date(day * DAY_MS);
const lines = (text) => html `${text.split('\n').map((line, i) => html `${i > 0 && raw('<br>')}${line}`)}`;
function streakLine(s) {
    const sub = [
        s.streak === 0 ? t('rec.start') : !s.studiedToday ? t('rec.keepUp', { n: s.streak + 1 }) : '',
        s.best > 1 ? t('rec.best', { n: s.best }) : '',
    ].filter(Boolean).join(' · ');
    return html `
        <div class="pg-record-streak"><b>${s.streak}</b><span>${t('rec.streakUnit')}</span></div>
        ${sub && html `<div class="pg-record-sub">${sub}</div>`}`;
}
/** This month: studied days in a soft band, consecutive ones joined like a date range. */
function monthView(s) {
    const now = dateOf(s.day);
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    const first = Math.round(Date.UTC(y, m, 1) / DAY_MS);
    const last = Math.round(Date.UTC(y, m + 1, 0) / DAY_MS);
    const lead = dateOf(first).getUTCDay();
    const on = (d) => d >= first && d <= last && s.counts.has(d);
    const cells = Array.from({ length: lead }, () => html `<span></span>`);
    for (let d = first; d <= last; d++) {
        const wd = dateOf(d).getUTCDay();
        const date = dateOf(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
        const cls = [
            'pg-mday',
            on(d) && 'pg-mday-on',
            on(d) && wd > 0 && on(d - 1) && 'pg-join-l',
            on(d) && wd < 6 && on(d + 1) && 'pg-join-r',
            d === s.day && 'pg-mday-today',
            d > s.day && 'pg-mday-future',
        ].filter(Boolean).join(' ');
        const tip = on(d) ? t('rec.cell', { date, n: s.counts.get(d) ?? 0 }) : date;
        cells.push(html `<span class="${cls}" title="${tip}"><span>${dateOf(d).getUTCDate()}</span></span>`);
    }
    const weekdays = Array.from({ length: 7 }, (_, i) => dateOf(first - lead + i).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' }));
    return html `
        <div class="pg-month">
            <div class="pg-month-title">${now.toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' })}</div>
            <div class="pg-month-grid pg-month-wd">${weekdays.map(w => html `<span>${w}</span>`)}</div>
            <div class="pg-month-grid">${cells}</div>
        </div>`;
}
function statsRow(s, fresh) {
    const pct = s.accuracy === null ? '—' : `${Math.round(s.accuracy * 100)}%`;
    const left = s.due + fresh;
    const item = (value, label, go) => go
        ? html `<button class="pg-record-stat pg-record-go" data-go="${go}"><span class="pg-record-val">${value}</span><span class="pg-record-lab">${label} ›</span></button>`
        : html `<div class="pg-record-stat"><span class="pg-record-val">${value}</span><span class="pg-record-lab">${label}</span></div>`;
    return html `
        <div class="pg-record-stats">
            ${item(s.today.n + s.today.r, t('rec.today'))}
            ${item(left, t('rec.due'), left > 0 ? 'review' : undefined)}
            ${item(pct, t('rec.accuracy'))}
            ${item(`${s.known}/${s.words}`, t('rec.words'))}
        </div>`;
}
function aheadRow(ahead, firstDay) {
    const max = Math.max(1, ...ahead);
    return html `
        <div class="pg-record-ahead">
            <span class="pg-record-ahead-lab">${t('rec.ahead')}</span>
            <span class="pg-record-ahead-bars">${ahead.map((n, i) => {
        const day = dateOf(firstDay + i).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' });
        return html `<span class="pg-record-ab" title="${day}: ${n}">
                    <i style="height:${n ? Math.max(15, Math.round(100 * n / max)) : 0}%"></i><b>${day}</b></span>`;
    })}</span>
            <span class="pg-record-ahead-lab">${t('rec.aheadTotal', { n: ahead.reduce((a, b) => a + b, 0) })}</span>
        </div>`;
}
/** Shows the record; `onReview` starts today's flashcard review. */
export function renderStudyRecord(container, onReview) {
    const pool = scopedWordbook().filter(isCard);
    const s = studyStats(daysData(), pool);
    const fresh = Math.min(pool.filter(isFresh).length, Math.max(0, (getSettings().srs_new_per_day ?? 20) - s.today.n));
    setHtml(container, html `
        <div class="pg-record">
            ${streakLine(s)}
            ${monthView(s)}
            ${statsRow(s, fresh)}
            ${aheadRow(s.ahead, s.day + 1)}
            <div class="pg-empty-hint pg-record-hint">${lines(t('det.hint'))}</div>
        </div>`);
    container.querySelector('[data-go="review"]')?.addEventListener('click', onReview);
}
