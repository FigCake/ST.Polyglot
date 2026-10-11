// Print-ready A5 flashcard deck:
//   • one front page + one back page per wordbook entry
//   • a conjugation-table section at the end (one verb per page)
//
// The browser's own print dialog ("Save as PDF") produces the file — no library.
//
// Design rules:
//   • renderFlashcardDocument() is pure (string in → string out) and unit-tested.
//   • All interpolated values go through the auto-escaping `html` tag.
//   • Styles live in pdf-styles.ts.
import { html, raw } from '../html.js';
import { notify } from '../ui.manager.js';
import { t } from '../i18n.js';
import { PDF_STYLES } from './pdf-styles.js';
import { rubyWord, shownReading } from '../furigana/word.js';
const MAX_COLLOCATIONS = 4;
// ── Card faces ────────────────────────────────────────────────────────────────
function cardHeader(e, trailing) {
    const level = e.level ?? '';
    return html `
    <div class="pg-card-header">
        <span class="pg-level-badge" data-level="${level}">${level || '?'}</span>
        ${e.pos && html `<span class="pg-pos-badge">${e.pos}</span>`}
        ${trailing}
    </div>`;
}
function cardFront(e, index, total) {
    const hasOrig = e.original_form && e.original_form !== e.word;
    return html `
<section class="pg-card pg-front">
    ${cardHeader(e, html `<span class="pg-card-num">${index + 1} / ${total}</span>`)}
    <div class="pg-card-body">
        <div class="pg-word">${rubyWord(e.word, shownReading(e))}</div>
        ${e.ipa && !shownReading(e) && html `<div class="pg-ipa">${e.ipa}</div>`}
        ${hasOrig && html `<div class="pg-orig-form">${e.original_form}</div>`}
    </div>
    <div class="pg-card-footer">
        <span class="pg-hint">▼ flip for meaning</span>
    </div>
</section>`;
}
function cardBack(e) {
    const collocs = (e.collocations ?? []).slice(0, MAX_COLLOCATIONS);
    const showContext = e.context_meaning && e.context_meaning !== e.meaning;
    return html `
<section class="pg-card pg-back">
    ${cardHeader(e, html `<div class="pg-word-sm">${e.word}</div>`)}
    <div class="pg-card-body">
        <div class="pg-meaning">${e.meaning}</div>
        ${showContext && html `<div class="pg-context-meaning">${e.context_meaning}</div>`}
        ${collocs.length > 0 && html `
        <div class="pg-collocs">${collocs.map(c => html `<span class="pg-colloc-chip">${c}</span>`)}</div>`}
        ${e.example && html `
        <div class="pg-example">"${e.example}"${e.example_translation && html `<div class="pg-example-trans">${e.example_translation}</div>`}</div>`}
    </div>
</section>`;
}
// ── Conjugation section ───────────────────────────────────────────────────────
function conjTense(tense) {
    return html `
        <div class="pg-conj-tense">
            <div class="pg-tense-name">${tense.name}<span class="pg-tense-native">${tense.name_native}</span></div>
            <table class="pg-conj-table">${(tense.rows ?? []).map(r => html `
                <tr><td class="pg-person">${r.person}</td><td class="pg-form">${r.form}</td></tr>`)}
            </table>
        </div>`;
}
function conjPage({ word, data }) {
    return html `
<section class="pg-conj-page">
    <div class="pg-conj-header">
        <span class="pg-conj-verb">${word}</span>
        ${data.translation && html `<span class="pg-conj-trans">${data.translation}</span>`}
    </div>
    <div class="pg-conj-grid">${(data.tenses ?? []).map(conjTense)}</div>
</section>`;
}
function conjSection(entries) {
    if (!entries.length)
        return raw('');
    return html `
<section class="pg-section-title pg-conj-section-title">
    <h2>Conjugation Tables</h2>
    <p>${entries.length} verb${entries.length > 1 ? 's' : ''}</p>
</section>
${entries.map(conjPage)}`;
}
// ── Document ──────────────────────────────────────────────────────────────────
/** Builds the complete, self-printing HTML document for the deck. */
export function renderFlashcardDocument(wordbook, conjEntries = []) {
    const total = wordbook.length;
    return html `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Polyglot Flashcards — ${total} words</title>
    <style>${raw(PDF_STYLES)}</style>
</head>
<body>
${wordbook.map((e, i) => [cardFront(e, i, total), cardBack(e)])}
${conjSection(conjEntries)}
<script>
    // Open the print dialog once fonts have loaded
    window.addEventListener('load', () => setTimeout(() => window.print(), 400));
</script>
</body>
</html>`.value;
}
/** How long the print window's blob URL stays valid (it is only needed for the initial load). */
const BLOB_URL_TTL_MS = 60_000;
/** Opens the deck in a new window, which immediately shows the print dialog. */
export function exportToPDF(wordbook, conjEntries = []) {
    if (!wordbook.length) {
        notify(t('wb.noExport'), 'warn');
        return;
    }
    const blob = new Blob([renderFlashcardDocument(wordbook, conjEntries)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'width=900,height=700');
    if (!win) {
        URL.revokeObjectURL(url);
        notify(t('wb.pdfPopupBlocked'), 'err', 4000);
        return;
    }
    setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
}
