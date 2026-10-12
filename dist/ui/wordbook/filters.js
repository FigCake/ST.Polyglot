// Wordbook list filters (level pill, frequently missed, word status, set, part of speech, search) — pure.
import { isMissed, isCard, wordStatus } from '../../srs.js';
export const emptyFilter = () => ({ level: 'all', setId: 'all', pos: '', query: '', missed: false, status: 'all' });
export function isFiltered(f) {
    return f.level !== 'all' || f.setId !== 'all' || !!f.pos || !!f.query.trim() || f.missed || f.status !== 'all';
}
function matchesLevel(w, level) {
    if (level === 'all')
        return true;
    if (level === 'grammar')
        return !w.level || w.level === 'grammar'; // untagged entries count as grammar
    return w.level === level;
}
function matchesQuery(w, q) {
    const has = (s) => !!s && s.toLowerCase().includes(q);
    return has(w.word) || has(w.base_form) || has(w.meaning) || has(w.notes) || (w.collocations ?? []).some(has);
}
/** Entries matching every active filter, newest first. */
export function applyFilter(wordbook, f) {
    const q = f.query.trim().toLowerCase();
    return wordbook
        .filter(w => matchesLevel(w, f.level) &&
        (!f.pos || w.pos === f.pos) &&
        (!f.missed || isMissed(w)) &&
        (f.status === 'all' || (isCard(w) && wordStatus(w) === f.status)) &&
        (f.setId === 'all' || (w.setIds ?? []).includes(f.setId)) &&
        (!q || matchesQuery(w, q)))
        .reverse();
}
/** Splits `text` around the first case-insensitive occurrence of `query` (for <mark>ing it). */
export function splitMatch(text, query) {
    const q = query.trim();
    if (!q || !text)
        return null;
    const m = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu').exec(text);
    if (!m)
        return null;
    return [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)];
}
