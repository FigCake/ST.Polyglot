// Imports a CSV (Polyglot export) or tab-separated TXT (flashcard-app export)
// into the wordbook and the open chat, as a new set named after the file.
//
//   CSV  with a header row: columns by name (word, base_form, meaning, level,
//        original_form, context_meaning) — the format exportToCSV() writes
//   CSV  without a header:  word, meaning, level, original_form, context_meaning
//   TXT  word ⇥ meaning(HTML, may contain "Base: …") ⇥ level ⇥ tags ⇥ original_form ⇥ context_meaning
//
// A .json file goes to the backup restore (ui/backup-ui.ts) instead, and an
// Anki package to its import dialog (ui/wordbook/deck-dialog.ts).
//
// parseWordbookFile() is pure and unit-tested; importWordbookFile() applies it.
import { CEFR_LEVELS } from '../../constants.js';
import { notify } from '../../ui.manager.js';
import { t } from '../../i18n.js';
import { getNativeLang } from '../../runtime.js';
import { currentChatId } from '../../storage.js';
import { tagChat, tagLang } from '../../wordbook-model.js';
import { loadWordbook, saveWordbook, createSet, deleteSet, splitCsvLines, studyLangKey } from '../../wordbook.js';
import { restoreFromFile } from '../backup-ui.js';
import { importAnkiFile } from './deck-dialog.js';
import { fieldText } from '../../deck-import/fields.js';
const VALID_LEVELS = new Set([...CEFR_LEVELS, 'grammar', 'sentence', 'idiom']);
const HEADER_ROW = /^["']?word["']?[,\t]/i;
/** Splits one CSV line, honouring quotes and "" escapes. */
function csvCells(line) {
    const cells = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && quoted && line[i + 1] === '"') {
            cur += '"';
            i++;
        }
        else if (c === '"')
            quoted = !quoted;
        else if (c === ',' && !quoted) {
            cells.push(cur);
            cur = '';
        }
        else
            cur += c;
    }
    cells.push(cur);
    return cells;
}
/** Removes flashcard-app media tags. */
const withoutMedia = (s = '') => s.replace(/<img[^>]*>/gi, '').replace(/\[sound:[^\]]*\]/gi, '').trim();
function normaliseLevel(s) {
    const v = s.trim();
    if (VALID_LEVELS.has(v.toUpperCase()))
        return v.toUpperCase();
    return VALID_LEVELS.has(v) ? v : 'A1';
}
const COLUMNS = ['word', 'base_form', 'meaning', 'level', 'original_form', 'context_meaning'];
/** Column positions: from a header row when present, else the legacy layout. */
function columnIndex(header, tsv) {
    if (header) {
        const names = header.map(h => h.toLowerCase());
        return Object.fromEntries(COLUMNS.map(c => [c, names.indexOf(c)]).filter(([, i]) => i >= 0));
    }
    const extra = tsv ? 1 : 0; // the TXT format has a tags column before original_form
    return { word: 0, meaning: 1, level: 2, original_form: 3 + extra, context_meaning: 4 + extra };
}
/** Rows that have at least a word and a meaning; comments and blanks are skipped. */
export function parseWordbookFile(text) {
    // Tab-separated when the first record is (a tab inside a CSV field does not count)
    const first = text.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? '';
    const tsv = /^#separator:tab/m.test(text) || (first.includes('\t') && !first.startsWith('"'));
    const lines = (tsv ? text.split('\n') : splitCsvLines(text)).filter(l => l.trim() && !l.startsWith('#'));
    // CSV cells are unquoted by csvCells; TSV cells may still be wrapped in quotes
    const split = (line) => (tsv ? line.split('\t').map(c => c.replace(/^"|"$/g, '')) : csvCells(line)).map(withoutMedia);
    // A flashcard TXT holds HTML (#html:true): its text cells are decoded too
    const plain = (s) => (tsv ? fieldText(s) : s);
    const header = lines.length && HEADER_ROW.test(lines[0].trim()) ? split(lines.shift()) : null;
    const col = columnIndex(header, tsv);
    const raw = (cells, c) => (col[c] === undefined ? '' : cells[col[c]] ?? '');
    const cell = (cells, c) => plain(raw(cells, c));
    const rows = [];
    for (const line of lines) {
        const cells = split(line);
        const word = cell(cells, 'word');
        const rawMeaning = raw(cells, 'meaning');
        if (!word || !rawMeaning)
            continue;
        const hinted = /Base:\s*([^<]+)/i.exec(rawMeaning)?.[1];
        const hintedBase = hinted ? plain(hinted).trim() : undefined;
        const level = cell(cells, 'level');
        rows.push({
            word,
            base_form: cell(cells, 'base_form') || hintedBase || word,
            meaning: fieldText(rawMeaning).replace(/\s*Base:[^.]*$/i, '').trim(),
            level: level ? normaliseLevel(level) : 'A1',
            original_form: cell(cells, 'original_form') || undefined,
            context_meaning: cell(cells, 'context_meaning') || undefined,
        });
    }
    return rows;
}
/**
 * Adds the file's rows to a new set named after the file. Words already in the
 * wordbook are only added to that set. Returns the set, or null if nothing changed.
 */
function importWordbookFile(text, filename) {
    const rows = parseWordbookFile(text);
    const setName = filename.replace(/\.(csv|txt)$/i, '');
    if (!rows.length) {
        notify(t('wb.importNone'), 'warn');
        return null;
    }
    const setId = createSet(setName);
    const chatId = currentChatId();
    const wordbook = loadWordbook();
    const byWord = new Map(wordbook.map(w => [w.word, w]));
    let added = 0, updated = 0;
    for (const row of rows) {
        const existing = byWord.get(row.word);
        if (existing) {
            existing.setIds ??= [];
            const inSet = existing.setIds.includes(setId);
            if (!inSet)
                existing.setIds.push(setId);
            const langTagged = tagLang(existing, studyLangKey());
            if (tagChat(existing, chatId) || !inSet || langTagged)
                updated++;
            continue;
        }
        const entry = {
            ...row,
            meaning_lang: getNativeLang() || undefined,
            setIds: [setId],
            chats: chatId ? [chatId] : [],
            langs: [studyLangKey()],
            dateAdded: new Date().toISOString(),
        };
        wordbook.push(entry);
        byWord.set(row.word, entry);
        added++;
    }
    if (!added && !updated) {
        deleteSet(setId);
        notify(t('wb.importNone'), 'warn');
        return null;
    }
    saveWordbook(wordbook);
    notify(added && updated ? t('wb.importBoth', { added, updated, set: setName })
        : added ? t('wb.importNew', { n: added, set: setName })
            : t('wb.importUpdate', { n: updated, set: setName }), 'ok', 4000);
    return { setId };
}
/**
 * Opens a file picker. CSV / TXT files are imported as a set, an Anki package
 * (.apkg / .colpkg) through its import dialog, and a .json file (or a .zip
 * with media) is treated as a full Polyglot backup. Resolves with null when nothing changed.
 */
export function pickAndImport() {
    return new Promise(resolve => {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.csv,.txt,.json,.zip,.apkg,.colpkg' });
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) {
                resolve(null);
                return;
            }
            if (/\.(apkg|colpkg)$/i.test(file.name)) {
                const sets = await importAnkiFile(file);
                // One deck: show its set; several: show everything
                resolve(sets.length ? { setId: sets.length === 1 ? sets[0] : undefined } : null);
                return;
            }
            try {
                if (/\.(json|zip)$/i.test(file.name))
                    resolve((await restoreFromFile(file)) ? {} : null);
                else
                    resolve(importWordbookFile(await file.text(), file.name));
            }
            catch {
                notify(t('wb.importFail'), 'err');
                resolve(null);
            }
        });
        input.click();
    });
}
