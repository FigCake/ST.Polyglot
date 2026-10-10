// ════════════════════════════
// Polyglot  wordbook.ts
// ════════════════════════════
// Wordbook data layer — CRUD, sets, CSV/TXT export, CSV parsing.
//
// One shared wordbook holds every chat's words; each entry lists the chats it
// belongs to. Pure rules live in wordbook-model.ts; where the data is stored
// is data-store.ts's concern.
//
// Design rules:
//   • No UI rendering. Functions that need a DOM refresh return a value;
//     callers (ui/wordbook-ui.ts) handle it.
//   • Writes always go through loadWordbook() (all entries); scopedWordbook()
//     is for reading what the user sees, never for saving back.
//
// Dependencies: constants.ts, types.ts, conj-cache.ts, ui.manager.ts (notify only),
//               storage.ts, runtime.ts, data-store.ts, wordbook-model.ts
import { KEY, SRS as SRS_CFG } from './constants.js';
import { getSettings, getLang } from './runtime.js';
import { wordbookData, setsData, replaceUserData, flush, storeMode } from './data-store.js';
import { clearConjCacheStore, setConjCache, deleteConjCache } from './conj-cache.js';
import { notify } from './ui.manager.js';
import { downloadText } from './export/download.js';
import { t } from './i18n.js';
import { chatValue, currentChatId } from './storage.js';
import { inScope, tagChat, mergeWordbooks, removeChats, removeWords, moveChats, chatOverview, findDuplicates, mergeGroup, editEntry, } from './wordbook-model.js';
// ════════════════════════════
// Wordbook read / write
// ════════════════════════════
/**
 * The shared wordbook — every chat's words (a live array: mutate, then saveWordbook()).
 * Use scopedWordbook() for what the user should see or study.
 */
export function loadWordbook() {
    return wordbookData();
}
export function saveWordbook(wordbook) {
    replaceUserData({ wordbook });
}
export const currentScope = () => getSettings().wordbook_scope ?? 'chat';
/** Whether words can be shown across chats (not when each chat stores its own words). */
export const isShared = () => storeMode() !== 'chat';
/** Entries in the chosen scope: the open chat's words, or all of them. */
export function scopedWordbook(scope = currentScope()) {
    if (!isShared())
        return loadWordbook();
    const chatId = currentChatId();
    return loadWordbook().filter(e => inScope(e, scope, chatId));
}
/** Deletes conjugation tables of words that left the wordbook. */
function forget(deleted) {
    deleted.forEach(deleteConjCache);
}
/**
 * Removes words from the current scope: in a chat view they leave this chat
 * (and are deleted only if no other chat has them); in "all" they are deleted.
 */
export function removeFromWordbook(words) {
    const chatId = currentChatId();
    const set = new Set(words);
    const { wordbook, deleted } = currentScope() === 'chat' && chatId && isShared()
        ? removeChats(loadWordbook(), [chatId], set)
        : removeWords(loadWordbook(), set);
    saveWordbook(wordbook);
    forget(deleted);
}
// ── Per-chat management ───────────────────────────────────────────────────────
export const wordbookByChat = () => chatOverview(loadWordbook());
/** Moves the words of the given chats (UNSORTED = words without a chat) into the open chat. */
export function moveChatsHere(chatIds) {
    const target = currentChatId();
    if (!target)
        return 0;
    const { wordbook, moved } = moveChats(loadWordbook(), chatIds.filter(c => c !== target), target);
    saveWordbook(wordbook);
    return moved;
}
/** Removes the given chats' words (words shared with other chats stay there). Returns how many were deleted. */
export function deleteChatWords(chatIds) {
    const { wordbook, deleted } = removeChats(loadWordbook(), chatIds);
    saveWordbook(wordbook);
    forget(deleted);
    return deleted.length;
}
// ── Duplicates and editing ────────────────────────────────────────────────────
/** Groups of the same word among the visible entries (the entry to keep first). */
export const duplicateGroups = () => findDuplicates(scopedWordbook());
/** Merges `words` into the first one. Returns how many entries were folded in. */
export function mergeDuplicates(words) {
    const { wordbook, removed } = mergeGroup(loadWordbook(), words);
    if (!removed.length)
        return 0;
    saveWordbook(wordbook);
    forget(removed);
    return removed.length;
}
/** Edits a word in place (renaming onto an existing word merges them). */
export function editWord(word, patch) {
    const result = editEntry(loadWordbook(), word, patch);
    saveWordbook(result.wordbook);
    if (result.formChanged)
        deleteConjCache(word);
    return result;
}
// ── Migration from per-chat storage ───────────────────────────────────────────
/** Before v1.5 each chat stored its own wordbook in its metadata. */
const legacyChatWordbook = chatValue(KEY.wordbook);
/**
 * Moves the open chat's old per-chat wordbook into the shared one, tagged with
 * this chat. Runs whenever a chat opens; the chat's copy is removed only once
 * the shared wordbook has been saved. Returns how many entries moved.
 */
export async function migrateChatWordbook() {
    const chatId = currentChatId();
    const legacy = legacyChatWordbook.get();
    if (!chatId || !Array.isArray(legacy) || storeMode() !== 'file')
        return 0;
    const incoming = legacy.filter(e => e?.word).map(e => ({ ...e, chats: [chatId] }));
    if (incoming.length)
        saveWordbook(mergeWordbooks(loadWordbook(), incoming).wordbook);
    if (!(await flush()) || currentChatId() !== chatId)
        return 0;
    legacyChatWordbook.delete();
    return incoming.length;
}
// ════════════════════════════
// Conjugation cache reset
// ════════════════════════════
/**
 * Clears every cached conjugation table and resets conj_cached flags.
 * IDB wipe → conj-cache.ts; wordbook flag reset is here (needs loadWordbook/saveWordbook).
 */
export async function clearAllConjCache() {
    await clearConjCacheStore();
    const wb = loadWordbook();
    let changed = false;
    wb.forEach(w => { if (w.conj_cached) {
        w.conj_cached = false;
        changed = true;
    } });
    if (changed)
        saveWordbook(wb);
}
// ════════════════════════════
// Word sets CRUD
// ════════════════════════════
export function getSets() { return setsData(); }
export function saveSets(sets) { replaceUserData({ sets }); }
export function newSetId() { return 'set_' + Date.now() + '_' + Math.random().toString(36).slice(2); }
export function createSet(name) {
    const sets = getSets();
    const id = newSetId();
    sets.push({ id, name });
    saveSets(sets);
    return id;
}
export function deleteSet(id) {
    saveSets(getSets().filter(s => s.id !== id));
    // Also remove this set from all words
    const wb = loadWordbook();
    wb.forEach(w => { w.setIds = (w.setIds || []).filter(s => s !== id); });
    saveWordbook(wb);
}
/**
 * Removes sets that have no words assigned to them.
 * Called once at startup to clean up orphans left by import bugs or
 * interrupted operations.
 */
export function pruneOrphanSets() {
    const sets = getSets();
    if (sets.length === 0)
        return;
    const wb = loadWordbook();
    const usedIds = new Set(wb.flatMap(w => w.setIds || []));
    const pruned = sets.filter(s => usedIds.has(s.id));
    if (pruned.length !== sets.length)
        saveSets(pruned);
}
export function toggleWordInSet(word, setId) {
    const wb = loadWordbook();
    const entry = wb.find(w => w.word === word);
    if (!entry)
        return;
    const idx = (entry.setIds || []).indexOf(setId);
    if (idx === -1)
        entry.setIds.push(setId);
    else
        entry.setIds.splice(idx, 1);
    saveWordbook(wb);
}
/**
 * Adds a word (stored under its base form) to the wordbook and the open chat.
 * A word that already exists is only added to the open chat.
 *
 * @returns 'added', 'tagged' (existing word joined this chat), or null (nothing changed).
 */
export function addToWordbook(wordData, { quiet = false } = {}) {
    const wordbook = loadWordbook();
    const canonical = wordData.base_form?.trim() || wordData.word;
    if (!canonical?.trim())
        return null; // malformed AI response
    const chatId = currentChatId();
    const existing = wordbook.find(w => w.word === canonical);
    if (existing) {
        const tagged = tagChat(existing, chatId);
        if (tagged)
            saveWordbook(wordbook);
        if (!quiet)
            notify(t(tagged ? 'wb.addedToChat' : 'wb.alreadyIn', { word: canonical }), 'info');
        return tagged ? 'tagged' : null;
    }
    // An explicit original_form wins; otherwise keep the surface form when it differs
    const surfaceForm = wordData.original_form ?? (wordData.word !== canonical ? wordData.word : undefined);
    const conjData = wordData.conj_cache;
    wordbook.push({
        word: canonical,
        base_form: wordData.base_form ?? canonical,
        level: wordData.level ?? '',
        meaning: wordData.meaning,
        meaning_lang: wordData.meaning_lang,
        pos_info: wordData.pos_info,
        reading: wordData.reading,
        original_form: surfaceForm,
        context_meaning: wordData.context_meaning || (surfaceForm ? wordData.meaning : undefined),
        setIds: [],
        chats: chatId ? [chatId] : [],
        dateAdded: new Date().toISOString(),
        conj_cached: !!conjData,
        srs_interval: SRS_CFG.initialInterval,
        srs_ease: SRS_CFG.defaultEase,
        srs_due: Date.now(),
    });
    saveWordbook(wordbook);
    if (conjData)
        setConjCache(canonical, conjData, getLang()); // fire-and-forget IDB write
    return 'added';
}
// ════════════════════════════
// Export
// ════════════════════════════
export function exportToCSV(wordbook) {
    if (!wordbook.length) {
        notify(t('wb.noExport'), 'warn');
        return;
    }
    // Escape double quotes (RFC 4180) and collapse any embedded newlines so each
    // wordbook entry maps to exactly one CSV row.
    const esc = (v) => String(v || '').replace(/[\n\r]/g, ' ').replace(/"/g, '""');
    const rows = [
        '"word","base_form","meaning","level","original_form","context_meaning"',
        ...wordbook.map(e => `"${esc(e.word)}","${esc(e.base_form)}","${esc(e.meaning)}","${esc(e.level)}","${esc(e.original_form)}","${esc(e.context_meaning)}"`)
    ].join('\n');
    downloadText(rows, 'Polyglot_Wordbook.csv');
}
/** Exports wordbook as a tab-separated TXT compatible with popular flashcard apps. */
export function exportToFlashcardTxt(wordbook) {
    if (!wordbook.length) {
        notify(t('wb.noExport'), 'warn');
        return;
    }
    // Generic metadata header recognised by major flashcard apps
    const content = '#separator:tab\n#html:true\n#tags column:4\n';
    const rows = wordbook.map(e => {
        const word = String(e.word || '').replace(/[\t\n\r]/g, ' ');
        const meaning = String(e.meaning || '').replace(/[\t\n\r]/g, ' ');
        const base = String(e.base_form || '').replace(/[\t\n\r]/g, ' ');
        const level = String(e.level || '').replace(/[\t\n\r]/g, ' ');
        let back = meaning;
        if (base && base !== word)
            back += `<br><br><i style="color:gray;">Base: ${base}</i>`;
        const orig = String(e.original_form || '').replace(/[\t\n\r]/g, ' ');
        const ctx = String(e.context_meaning || '').replace(/[\t\n\r]/g, ' ');
        return `${word}\t${back}\t${level}\tPolyglot\t${orig}\t${ctx}`;
    }).join('\n');
    downloadText(content + rows, 'Polyglot_Flashcards.txt');
}
// PDF flashcard export → see export/pdf.ts
// ════════════════════════════
// CSV parsing utilities
// ════════════════════════════
/** CSV line splitter that correctly handles quoted fields containing newlines. */
export function splitCsvLines(text) {
    const lines = [];
    let curLine = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            if (inQuotes && text[i + 1] === '"') {
                curLine += '"';
                i++;
                continue;
            }
            inQuotes = !inQuotes;
            curLine += char;
        }
        else if (char === '\n' && !inQuotes) {
            lines.push(curLine);
            curLine = '';
        }
        else if (char === '\r') {
            // skip bare carriage returns
        }
        else {
            curLine += char;
        }
    }
    if (curLine.trim())
        lines.push(curLine);
    return lines;
}
// ════════════════════════════
// Migrations
// ════════════════════════════
