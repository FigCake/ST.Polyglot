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
import { KEY, SRS as SRS_CFG } from './constants.js';
import { getSettings, getLang } from './runtime.js';
import { wordbookData, setsData, replaceUserData, flush, storeMode } from './data-store.js';
import { clearConjCacheStore, setConjCache, deleteConjCache } from './conj-cache.js';
import { notify, escapeHtml } from './ui.manager.js';
import { downloadText } from './export/download.js';
import { t } from './i18n.js';
import { chatValue, currentChatId } from './storage.js';
import { inScope, tagChat, mergeWordbooks, removeChats, removeWords, moveChats, chatOverview, findDuplicates, mergeGroup, editEntry, } from './wordbook-model.js';
// ── Wordbook read / write ─────────────────────────────────────────────────────
/** Every chat's words, as a live array: mutate, then saveWordbook(). Use scopedWordbook() for display. */
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
 * Moves the open chat's pre-1.5 wordbook into the shared one, tagged with this
 * chat. The chat's copy is removed only once the shared wordbook has been saved.
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
// ── Conjugation cache reset ───────────────────────────────────────────────────
/** Clears every cached conjugation table and resets the entries' conj_cached flags. */
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
// ── Word sets CRUD ────────────────────────────────────────────────────────────
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
    const wb = loadWordbook();
    wb.forEach(w => { w.setIds = (w.setIds || []).filter(s => s !== id); });
    saveWordbook(wb);
}
export function toggleWordInSet(word, setId) {
    const wb = loadWordbook();
    const entry = wb.find(w => w.word === word);
    if (!entry)
        return;
    entry.setIds ??= []; // old chat wordbooks have entries without it
    const idx = entry.setIds.indexOf(setId);
    if (idx === -1)
        entry.setIds.push(setId);
    else
        entry.setIds.splice(idx, 1);
    saveWordbook(wb);
}
/**
 * Adds a word (stored under its base form) to the wordbook and the open chat.
 * 'tagged' = an existing word joined this chat; null = nothing changed.
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
        // What a lookup already found (AI data: checked), so it need not be re-analysed
        ...(typeof wordData.pos === 'string' && wordData.pos && { pos: wordData.pos }),
        ...(typeof wordData.ipa === 'string' && wordData.ipa && { ipa: wordData.ipa }),
        ...(typeof wordData.notes === 'string' && wordData.notes && { notes: wordData.notes }),
        ...(Array.isArray(wordData.collocations) && wordData.collocations.length
            && { collocations: wordData.collocations.filter((c) => typeof c === 'string') }),
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
// ── Export ────────────────────────────────────────────────────────────────────
export function exportToCSV(wordbook) {
    if (!wordbook.length) {
        notify(t('wb.noExport'), 'warn');
        return;
    }
    downloadText(wordbookCsv(wordbook), 'Polyglot_Wordbook.csv');
}
/** The CSV export's text: RFC 4180 quoting; newlines collapse so each entry is one row. */
export function wordbookCsv(wordbook) {
    const esc = (v) => String(v || '').replace(/[\n\r]/g, ' ').replace(/"/g, '""');
    return [
        '"word","base_form","meaning","level","original_form","context_meaning"',
        ...wordbook.map(e => `"${esc(e.word)}","${esc(e.base_form)}","${esc(e.meaning)}","${esc(e.level)}","${esc(e.original_form)}","${esc(e.context_meaning)}"`),
    ].join('\n');
}
/** Tab-separated TXT in the format Anki and similar flashcard apps import. */
export function exportToFlashcardTxt(wordbook) {
    if (!wordbook.length) {
        notify(t('wb.noExport'), 'warn');
        return;
    }
    downloadText(flashcardTxt(wordbook), 'Polyglot_Flashcards.txt');
}
/** The TXT export's text, with the metadata header major flashcard apps recognise. */
export function flashcardTxt(wordbook) {
    const content = '#separator:tab\n#html:true\n#tags column:4\n';
    // The file says #html:true, so text is escaped: a meaning written by the AI
    // or imported from someone else must not run as markup in the flashcard app
    const cell = (v) => escapeHtml(String(v || '').replace(/[\t\n\r]/g, ' '));
    const rows = wordbook.map(e => {
        const word = cell(e.word), base = cell(e.base_form);
        let back = cell(e.meaning);
        if (base && base !== word)
            back += `<br><br><i style="color:gray;">Base: ${base}</i>`;
        return `${word}\t${back}\t${cell(e.level)}\tPolyglot\t${cell(e.original_form)}\t${cell(e.context_meaning)}`;
    }).join('\n');
    return content + rows;
}
// PDF flashcard export → see export/pdf.ts
// ── CSV parsing utilities ─────────────────────────────────────────────────────
/** Splits CSV into records, keeping newlines inside quoted fields. */
export function splitCsvLines(text) {
    const lines = [];
    let curLine = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            // An escaped quote stays escaped: splitting cells unescapes it
            if (inQuotes && text[i + 1] === '"') {
                curLine += '""';
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
