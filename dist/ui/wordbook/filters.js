// Wordbook list filters (level pill, frequently missed, no sound, word status, set, part of speech, search) — pure.
import { isMissed, isCard, wordStatus } from '../../srs.js';
import { lacksSound } from '../../word-sounds.js';
export const emptyFilter = () => ({ level: 'all', setId: 'all', pos: '', query: '', missed: false, noSound: false, status: 'all' });
export function isFiltered(f) {
    return f.level !== 'all' || f.setId !== 'all' || !!f.pos || !!f.query.trim() || f.missed || f.noSound || f.status !== 'all';
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
/**
 * Whether the list leaves a word out as known (setting "hide known words"):
 * not when known words are asked for (the status filter) or searched for.
 */
export const hiddenAsKnown = (w, f, hideKnown) => hideKnown && f.status !== 'known' && !f.query.trim() && isCard(w) && wordStatus(w) === 'known';
/** Entries matching every active filter, newest first (known words left out with `hideKnown`). */
export function applyFilter(wordbook, f, hideKnown = false) {
    const q = f.query.trim().toLowerCase();
    return wordbook
        .filter(w => !hiddenAsKnown(w, f, hideKnown) &&
        matchesLevel(w, f.level) &&
        (!f.pos || w.pos === f.pos) &&
        (!f.missed || isMissed(w)) &&
        (!f.noSound || lacksSound(w)) &&
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
