// The correction archive: messages the input checker corrected, the newest
// CHECKS_KEPT across languages, kept in the data file with the wordbook.
import { checksData, replaceUserData } from './data-store.js';
import { recentChecks } from './user-data.js';
const newId = () => `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export function archiveCheck(entry, now = Date.now()) {
    replaceUserData({ checks: recentChecks([{ ...entry, id: newId(), at: now }, ...checksData()]) });
}
/** The archive for one study language, newest first. */
export const checksFor = (lang) => recentChecks(checksData()).filter(c => c.lang === lang);
export function deleteCheck(id) {
    replaceUserData({ checks: checksData().filter(c => c.id !== id) });
}
/** Sets or (with '') clears the learner's note on a check. */
export function setCheckNote(id, note) {
    replaceUserData({
        checks: checksData().map(c => {
            if (c.id !== id)
                return c;
            const { note: _old, ...rest } = c;
            return note.trim() ? { ...rest, note: note.trim() } : rest;
        }),
    });
}
