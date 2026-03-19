// ════════════════════════════
// Polyglot  wordbook.ts
// ════════════════════════════
// Wordbook data layer — CRUD, sets, import/export, migrations.
//
// Design rules:
//   • No UI rendering (no renderWordbook, no _panelTabs).
//     Functions that need a DOM refresh return a value; callers handle it.
//   • addToWordbook() returns boolean (true = added, false = duplicate).
//     The caller (index.ts wrapper) is responsible for triggering panel refresh.
//   • processImportedFile / triggerImport stay in index.ts — they depend on
//     wbFilter UI state and renderWordbook. Moved to ui/wordbook-ui.ts later.
//   • getLang() is private here (_getLang) — delegates to getLangFromSettings()
//     in utils.ts so the logic lives in exactly one place.
//
// Dependencies: constants.ts, types.ts, conj-cache.ts, ui.manager.ts (notify only),
//               ST internals (extension_settings, saveSettingsDebounced,
//               saveMetadataDebounced, getContext)
import { KEY, SRS as SRS_CFG } from './constants.js';
import { getLangFromSettings } from './utils.js';
import { clearConjCacheStore, setConjCache } from './conj-cache.js';
import { notify } from './ui.manager.js';
import { t } from './i18n.js';
// @ts-expect-error — no type declarations for ST internals
import { extension_settings, saveMetadataDebounced, getContext } from '../../../../extensions.js';
// @ts-expect-error — no type declarations for ST internals
import { saveSettingsDebounced } from '../../../../../script.js';
// ── Private helpers ───────────────────────────────────────────────────────────
/** Returns the Polyglot settings object, creating defaults if absent. */
function _getSettings() {
    return extension_settings[KEY.module];
}
/** Saves Polyglot extension settings via ST's debounced save. */
function _save() { saveSettingsDebounced(); }
/**
 * Returns the current learning language string.
 * Delegates to the shared getLangFromSettings() utility so the logic
 * is defined in exactly one place (utils.ts).
 */
function _getLang() { return getLangFromSettings(_getSettings()); }
// ════════════════════════════
// Wordbook read / write
// ════════════════════════════
/** Pure read — returns the current wordbook without any side-effects. */
export function loadWordbook() {
    const ctx = getContext();
    if (ctx.chatMetadata) {
        return Array.isArray(ctx.chatMetadata[KEY.wordbook])
            ? ctx.chatMetadata[KEY.wordbook]
            : [];
    }
    const s = _getSettings();
    return Array.isArray(s._wordbook) ? s._wordbook : [];
}
export function saveWordbook(wordbook) {
    const ctx = getContext();
    if (ctx.chatMetadata) {
        ctx.chatMetadata[KEY.wordbook] = wordbook;
        _persistWordbook(ctx);
    }
    else {
        _getSettings()._wordbook = wordbook;
        _save();
    }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _persistWordbook(ctx) {
    // Prefer the directly-imported saveMetadataDebounced; fall back to context method
    if (typeof saveMetadataDebounced === 'function') {
        saveMetadataDebounced();
        return;
    }
    if (typeof ctx.saveMetadata === 'function')
        ctx.saveMetadata();
    else if (typeof ctx.saveMetadataDebounced === 'function')
        ctx.saveMetadataDebounced();
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
export function getSets() { return _getSettings()._sets || []; }
export function saveSets(sets) { _getSettings()._sets = sets; _save(); }
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
// ════════════════════════════
// Add word
// ════════════════════════════
/**
 * Adds a word to the wordbook.
 *
 * @returns `true` if the word was added, `false` if it was already present
 *          (duplicate — a toast is shown internally).
 *
 * NOTE: Does NOT call renderWordbook. Callers in index.ts are responsible
 *       for refreshing the panel after a successful add.
 */
export function addToWordbook(wordData) {
    const wordbook = loadWordbook();
    const canonical = (wordData.base_form && wordData.base_form.trim())
        ? wordData.base_form.trim()
        : wordData.word;
    if (!canonical?.trim())
        return false; // guard against empty word (malformed AI response)
    if (wordbook.find(w => w.word === canonical)) {
        notify(t('wb.alreadyIn', { word: canonical }), 'info');
        return false;
    }
    // Prefer an explicitly passed original_form; fall back to the surface word
    // when it differs from the canonical (base) form.
    const surfaceForm = wordData.original_form ?? (wordData.word !== canonical ? wordData.word : undefined);
    const conjData = wordData.conj_cache;
    const entry = {
        word: canonical,
        base_form: wordData.base_form ?? canonical,
        level: wordData.level ?? '',
        meaning: wordData.meaning,
        meaning_lang: wordData.meaning_lang,
        pos_info: wordData.pos_info,
        original_form: surfaceForm,
        context_meaning: wordData.context_meaning || (surfaceForm ? wordData.meaning : undefined),
        setIds: [],
        dateAdded: new Date().toISOString(),
        conj_cached: !!conjData,
        srs_interval: SRS_CFG.initialInterval,
        srs_ease: SRS_CFG.defaultEase,
        srs_due: Date.now(),
    };
    wordbook.push(entry);
    saveWordbook(wordbook);
    if (conjData) {
        // Fire-and-forget — UI does not need to wait for IDB write
        setConjCache(canonical, conjData, _getLang());
    }
    return true;
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
    _downloadFile(rows, 'Polyglot_Wordbook.csv');
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
    _downloadFile(content + rows, 'Polyglot_Flashcards.txt');
}
/**
 * Opens a print window containing:
 *   • One front page + one back page per wordbook entry
 *   • A conjugation table section at the end (one table per page)
 *
 * The browser's native print dialog ("Save as PDF") produces the output.
 * No external library required.
 */
export function exportToPDF(wordbook, conjEntries = []) {
    if (!wordbook.length) {
        notify(t('wb.noExport'), 'warn');
        return;
    }
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // ── Level badge colour ──────────────────────────────────────────────────
    const LEVEL_COLORS = {
        A1: '#4caf7d', A2: '#4caf7d',
        B1: '#2196f3', B2: '#2196f3',
        C1: '#9c27b0', C2: '#9c27b0',
        grammar: '#ff9800', sentence: '#607d8b', idiom: '#e91e63',
    };
    const levelColor = (l) => LEVEL_COLORS[l] ?? '#888';
    // ── Card pages ─────────────────────────────────────────────────────────
    const cardPages = wordbook.map(e => {
        const level = e.level ?? '';
        const hasOrig = e.original_form && e.original_form !== e.word;
        const collocs = (e.collocations ?? []).slice(0, 4);
        // ── Front face ────────────────────────────────────────────────────
        const front = `
<div class="pg-card pg-front">
    <div class="pg-card-header">
        <span class="pg-level-badge" style="background:${levelColor(level)}">${esc(level || '?')}</span>
        ${e.pos ? `<span class="pg-pos-badge">${esc(e.pos)}</span>` : ''}
        <span class="pg-card-num"></span>
    </div>
    <div class="pg-card-body">
        <div class="pg-word">${esc(e.word)}</div>
        ${e.ipa ? `<div class="pg-ipa">${esc(e.ipa)}</div>` : ''}
        ${hasOrig ? `<div class="pg-orig-form">${esc(e.original_form)}</div>` : ''}
    </div>
    <div class="pg-card-footer">
        <span class="pg-hint">▼ flip for meaning</span>
    </div>
</div>`;
        // ── Back face ─────────────────────────────────────────────────────
        const back = `
<div class="pg-card pg-back">
    <div class="pg-card-header">
        <span class="pg-level-badge" style="background:${levelColor(level)}">${esc(level || '?')}</span>
        ${e.pos ? `<span class="pg-pos-badge">${esc(e.pos)}</span>` : ''}
        <div class="pg-word-sm">${esc(e.word)}</div>
    </div>
    <div class="pg-card-body">
        <div class="pg-meaning">${esc(e.meaning)}</div>
        ${e.context_meaning && e.context_meaning !== e.meaning
            ? `<div class="pg-context-meaning">${esc(e.context_meaning)}</div>`
            : ''}
        ${collocs.length
            ? `<div class="pg-collocs">${collocs.map(c => `<span class="pg-colloc-chip">${esc(c)}</span>`).join('')}</div>`
            : ''}
        ${e.example
            ? `<div class="pg-example">"${esc(e.example)}"${e.example_translation ? `<div class="pg-example-trans">${esc(e.example_translation)}</div>` : ''}</div>`
            : ''}
    </div>
</div>`;
        return front + '\n' + back;
    }).join('\n');
    // ── Conjugation section ────────────────────────────────────────────────
    const conjSection = conjEntries.length ? `
<div class="pg-section-title pg-conj-section-title">
    <h2>Conjugation Tables</h2>
    <p>${conjEntries.length} verb${conjEntries.length > 1 ? 's' : ''}</p>
</div>
${conjEntries.map(({ word, data }) => `
<div class="pg-conj-page">
    <div class="pg-conj-header">
        <span class="pg-conj-verb">${esc(word)}</span>
        ${data.translation ? `<span class="pg-conj-trans">${esc(data.translation)}</span>` : ''}
    </div>
    <div class="pg-conj-grid">
        ${(data.tenses ?? []).map(tense => `
        <div class="pg-conj-tense">
            <div class="pg-tense-name">${esc(tense.name)}<span class="pg-tense-native">${esc(tense.name_native)}</span></div>
            <table class="pg-conj-table">
                ${(tense.rows ?? []).map(r => `
                <tr>
                    <td class="pg-person">${esc(r.person)}</td>
                    <td class="pg-form">${esc(r.form)}</td>
                </tr>`).join('')}
            </table>
        </div>`).join('')}
    </div>
</div>`).join('\n')}` : '';
    // ── Print stylesheet ───────────────────────────────────────────────────
    const css = `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        @page {
            size: A5 landscape;
            margin: 0;
        }

        body {
            font-family: 'Inter', 'Noto Sans', sans-serif;
            background: #f0f0f0;
            color: #1a1a2e;
        }

        /* ── Card base ──────────────────────────────────────── */
        .pg-card {
            width: 100vw;
            height: 100vh;
            page-break-after: always;
            display: flex;
            flex-direction: column;
            padding: 32px 40px 24px;
            position: relative;
            overflow: hidden;
        }

        /* Front: clean white */
        .pg-front {
            background: #ffffff;
            border-bottom: 6px solid #e8e8f0;
        }

        /* Back: very light tint */
        .pg-back {
            background: #fafafa;
            border-bottom: 6px solid #e8e8f0;
        }

        /* ── Card header ────────────────────────────────────── */
        .pg-card-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 0;
        }

        .pg-level-badge {
            font-size: 11px;
            font-weight: 700;
            color: #fff;
            padding: 3px 10px;
            border-radius: 100px;
            letter-spacing: 0.05em;
            text-transform: uppercase;
        }

        .pg-pos-badge {
            font-size: 11px;
            font-weight: 600;
            color: #666;
            background: #f0f0f4;
            padding: 3px 10px;
            border-radius: 100px;
            letter-spacing: 0.03em;
        }

        .pg-word-sm {
            font-size: 13px;
            font-weight: 600;
            color: #555;
            margin-left: auto;
            font-style: italic;
        }

        /* ── Card body ──────────────────────────────────────── */
        .pg-card-body {
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: center;
            gap: 12px;
        }

        /* Front — main word */
        .pg-word {
            font-size: 52px;
            font-weight: 700;
            letter-spacing: -0.02em;
            color: #1a1a2e;
            line-height: 1.1;
        }

        .pg-ipa {
            font-size: 20px;
            color: #7a7a9a;
            font-style: italic;
            letter-spacing: 0.02em;
        }

        .pg-orig-form {
            font-size: 16px;
            color: #aaa;
            font-style: italic;
        }

        /* Back — meaning */
        .pg-meaning {
            font-size: 32px;
            font-weight: 600;
            color: #1a1a2e;
            line-height: 1.25;
        }

        .pg-context-meaning {
            font-size: 16px;
            color: #888;
            font-style: italic;
            padding-left: 2px;
        }

        .pg-collocs {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 4px;
        }

        .pg-colloc-chip {
            font-size: 12px;
            background: #eef0ff;
            color: #4455aa;
            padding: 3px 10px;
            border-radius: 100px;
            font-weight: 500;
        }

        .pg-example {
            font-size: 14px;
            color: #444;
            font-style: italic;
            border-left: 3px solid #dde;
            padding-left: 12px;
            line-height: 1.6;
        }

        .pg-example-trans {
            font-size: 12px;
            color: #888;
            margin-top: 4px;
            font-style: normal;
        }

        /* ── Card footer ────────────────────────────────────── */
        .pg-card-footer {
            text-align: center;
        }

        .pg-hint {
            font-size: 11px;
            color: #ccc;
            letter-spacing: 0.05em;
        }

        /* ── Conjugation section ────────────────────────────── */
        .pg-section-title {
            width: 100vw;
            height: 100vh;
            page-break-after: always;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: #1a1a2e;
            color: #fff;
        }
        .pg-conj-section-title h2 {
            font-size: 48px;
            font-weight: 700;
            letter-spacing: -0.02em;
            margin-bottom: 12px;
        }
        .pg-conj-section-title p {
            font-size: 18px;
            color: rgba(255,255,255,0.55);
        }

        .pg-conj-page {
            width: 100vw;
            min-height: 100vh;
            page-break-after: always;
            padding: 32px 40px;
            background: #fff;
        }

        .pg-conj-header {
            display: flex;
            align-items: baseline;
            gap: 16px;
            margin-bottom: 24px;
            border-bottom: 2px solid #1a1a2e;
            padding-bottom: 12px;
        }

        .pg-conj-verb {
            font-size: 36px;
            font-weight: 700;
            color: #1a1a2e;
        }

        .pg-conj-trans {
            font-size: 18px;
            color: #888;
            font-style: italic;
        }

        .pg-conj-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 20px;
        }

        .pg-conj-tense {
            break-inside: avoid;
        }

        .pg-tense-name {
            font-size: 13px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: #1a1a2e;
            margin-bottom: 8px;
            display: flex;
            flex-direction: column;
            gap: 1px;
        }

        .pg-tense-native {
            font-size: 11px;
            color: #999;
            font-weight: 400;
            text-transform: none;
            letter-spacing: 0;
        }

        .pg-conj-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }

        .pg-conj-table tr {
            border-bottom: 1px solid #f0f0f0;
        }

        .pg-person {
            color: #999;
            padding: 4px 8px 4px 0;
            font-size: 12px;
            white-space: nowrap;
        }

        .pg-form {
            font-weight: 600;
            color: #1a1a2e;
            padding: 4px 0;
        }

        /* ── Screen preview (non-print) ─────────────────────── */
        @media screen {
            body { padding: 20px; }
            .pg-card {
                width: 148mm;
                height: 105mm;
                border-radius: 12px;
                box-shadow: 0 4px 24px rgba(0,0,0,0.12);
                margin: 12px auto;
                page-break-after: unset;
            }
            .pg-conj-page {
                width: 148mm;
                border-radius: 12px;
                box-shadow: 0 4px 24px rgba(0,0,0,0.10);
                margin: 12px auto;
                page-break-after: unset;
                min-height: unset;
            }
            .pg-section-title {
                width: 148mm;
                height: 60px;
                border-radius: 12px;
                margin: 12px auto;
                page-break-after: unset;
            }
        }
    `;
    const totalCards = wordbook.length;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Polyglot Flashcards — ${totalCards} words</title>
    <style>${css}</style>
</head>
<body>
${cardPages}
${conjSection}
<script>
    // Auto-open print dialog after fonts load
    window.addEventListener('load', () => setTimeout(() => window.print(), 400));
${'</script>'}
</body>
</html>`;
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) {
        notify(t('wb.pdfPopupBlocked'), 'err', 4000);
        return;
    }
    win.document.write(html);
    win.document.close();
}
function _downloadFile(content, filename) {
    const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}
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
