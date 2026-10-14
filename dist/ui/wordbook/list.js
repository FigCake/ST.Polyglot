// The wordbook word list: one row per entry, filtered by the toolbar.
//
// Rows are plain markup; a single delegated click / change handler on the list
// reads `data-action` and the row's `data-word`, so re-rendering never needs
// to re-bind anything.
import { POS_LABELS } from '../../constants.js';
import { levelClass, levelLabel } from '../../utils.js';
import { html, setHtml } from '../../html.js';
import { t, currentLang } from '../../i18n.js';
import { loadWordbook, scopedWordbook, removeFromWordbook, toggleWordInSet, setKnown } from '../../wordbook.js';
import { ai, getLang, getNativeLang, getSettings } from '../../runtime.js';
import { speak } from '../../voice.js';
import { speakButton } from '../../speak-button.js';
import { playGlyphHtml, pressGlyph } from '../play-glyph.js';
import { userFileUrl } from '../../user-files.js';
import { showConjugationPopupFromCache } from '../../features/conjugation.js';
import { isMissed, isKnown, isCard } from '../../srs.js';
import { applyFilter, hiddenAsKnown, isFiltered, splitMatch } from './filters.js';
import { rubyWord, shownReading } from '../../furigana/word.js';
import { toggleNoteEditor, openNoteEditor, isNoteEditorOpen } from './note-editor.js';
import { togglePopover } from './popover.js';
import { openEditForm } from './edit-form.js';
const contexts = new WeakMap();
/** Rows rendered at a time; "Show more" adds another page. Keeps big wordbooks responsive. */
const PAGE_SIZE = 200;
/** Rows currently shown per list, reset whenever the filter changes. */
const paging = new WeakMap();
// ── Row markup ────────────────────────────────────────────────────────────────
/** Text with the search match wrapped in <mark>. */
function marked(text, query) {
    const parts = splitMatch(text ?? '', query);
    return parts ? html `${parts[0]}<mark class="pg-wb-hl">${parts[1]}</mark>${parts[2]}` : html `${text ?? ''}`;
}
const dateLabel = (iso) => iso ? new Date(iso).toLocaleDateString(currentLang(), { month: 'short', day: 'numeric' }) : '';
function row(w, ctx) {
    const { filter, sets } = ctx;
    const posLabel = w.pos ? POS_LABELS[w.pos] : undefined;
    const date = dateLabel(w.dateAdded);
    return html `
        <div class="pg-wordbook-item" data-word="${w.word}">
            <div class="pg-wb-head">
                <div class="pg-wb-head-left">
                    <input type="checkbox" class="pg-wb-row-chk" data-word="${w.word}" title="${t('wb.selectRow')}" aria-label="${t('wb.selectRow')}">
                    <strong>${filter.query ? marked(w.word, filter.query) : rubyWord(w.word, shownReading(w))}${w.level === 'sentence' && playGlyphHtml(`${t('line.play')}: ${w.word}`, t('wb.listen'), 'play-sentence')}</strong>
                    ${posLabel && html `
                    <button class="pg-pos-chip${filter.pos === w.pos ? ' pg-pos-chip-active' : ''}" data-action="filter-pos" data-pos="${w.pos}" title="${t('wb.filterByPos')}">${posLabel}</button>`}
                </div>
                <div class="pg-wb-head-right">
                    ${w.level !== 'sentence' && speakButton({ saved: !!w.audio, label: t('wb.listen'), cls: 'pg-icon-btn', action: 'speak' })}
                    ${isCard(w) && html `
                    <button class="pg-icon-btn pg-wb-known-btn ${w.known && 'pg-wb-known-on'}" data-action="known" aria-pressed="${w.known ? 'true' : 'false'}"
                        title="${t(w.known ? 'wb.unmarkKnown' : 'wb.markKnown')}" aria-label="${t(w.known ? 'wb.unmarkKnown' : 'wb.markKnown')}"><i class="fa-solid fa-check"></i></button>`}
                    <button class="pg-icon-btn pg-wb-edit-btn" data-action="edit" title="${t('wb.edit')}" aria-label="${t('wb.edit')}"><i class="fa-solid fa-pen"></i></button>
                    <button class="pg-icon-btn pg-wb-del" data-action="delete" title="${t('wb.deleteWord')}" aria-label="${t('wb.deleteWord')}"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="pg-wb-mean">${marked(w.meaning, filter.query)}</div>
            <div class="pg-wb-meta">
                ${w.ipa && html `<span class="pg-ipa-chip">${w.ipa}</span>`}
                <span class="pg-level-badge level-${levelClass(w.level || 'grammar')}">${levelLabel(w.level)}</span>
                ${isMissed(w) && html `<span class="pg-missed-tag" title="${t('wb.missedTip')}">${t('wb.missedTag')}</span>`}
                ${isCard(w) && isKnown(w) && html `<span class="pg-known-tag" title="${t(w.known ? 'wb.knownSetTip' : 'wb.knownTip')}">${t('wb.knownTag')}</span>`}
                ${w.conj_cached && html `<button class="pg-icon-btn pg-wb-conj-btn" data-action="conjugate" title="${t('wb.conjTable')}">📊</button>`}
                <button class="pg-icon-btn pg-wb-note-btn${w.notes ? ' pg-wb-note-btn-has' : ''}" data-action="note" title="${t('wb.noteTitle')}">📝</button>
                ${date && html `<span class="pg-wb-date">${date}</span>`}
            </div>
            <div class="pg-wb-secondary" aria-hidden="true">
                ${w.image && html `<img class="pg-word-img" src="${userFileUrl(w.image)}" alt="" loading="lazy">`}
                ${w.pos_info && html `<div class="pg-wb-pos-info">${w.pos_info}</div>`}
                ${w.original_form && html `<button class="pg-wb-ctx-btn" data-action="context" title="${t('wb.viewCtx')}">${w.original_form}</button>`}
                ${(w.collocations?.length ?? 0) > 0 && html `<div class="pg-colloc-row">${(w.collocations ?? []).map(c => html `<span class="pg-colloc-chip">${c}</span>`)}</div>`}
                ${sets.length > 0 && html `
                <div class="pg-set-checks">${sets.map(s => html `
                    <label class="pg-set-check" title="${s.name}">
                        <input type="checkbox" data-set="${s.id}" ${(w.setIds ?? []).includes(s.id) && html `checked`}>
                        <span>${s.name}</span>
                    </label>`)}
                </div>`}
            </div>
            <div class="pg-wb-notes-preview" data-action="note-preview" ${!w.notes && html `hidden`}>${w.notes ?? ''}</div>
            <div class="pg-wb-note-editor" hidden></div>
        </div>`;
}
function emptyMessage(total, query, hidden) {
    if (!total)
        return t('wb.empty');
    if (hidden === total)
        return t('wb.allKnownHidden');
    return query.trim() ? t('wb.noMatchSearch', { q: query }) : t('wb.noMatch');
}
// ── Actions ───────────────────────────────────────────────────────────────────
const noteParts = (item) => ({
    editor: item.querySelector('.pg-wb-note-editor'),
    preview: item.querySelector('.pg-wb-notes-preview'),
    button: item.querySelector('.pg-wb-note-btn'),
});
function onClick(listEl, e) {
    const ctx = contexts.get(listEl);
    const target = e.target;
    if (ctx && target.closest('.pg-wb-more')) {
        const page = paging.get(listEl);
        if (page)
            page.limit += PAGE_SIZE;
        renderList(listEl, ctx);
        return;
    }
    const item = target.closest('.pg-wordbook-item');
    if (!ctx || !item)
        return;
    const word = item.dataset.word ?? '';
    const action = target.closest('[data-action]');
    if (!action) {
        // A click on the row body (not a control) expands the secondary details
        if (target.closest('button, input, a, select, label, textarea'))
            return;
        const open = item.classList.toggle('pg-wb-expanded');
        item.querySelector('.pg-wb-secondary')?.setAttribute('aria-hidden', String(!open));
        return;
    }
    e.stopPropagation();
    switch (action.dataset.action) {
        case 'speak':
            speak(word, getLang(), { audio: loadWordbook().find(w => w.word === word)?.audio, keep: { word, field: 'audio' } });
            break;
        case 'play-sentence':
            // The same small ▶ as a line of dialogue: pressed again while it reads, it stops
            pressGlyph(action, () => {
                const entry = loadWordbook().find(w => w.word === word);
                // A saved line of dialogue is read in the voice of the character who said it
                return speak(word, getLang(), { audio: entry?.audio, keep: { word, field: 'audio' }, speaker: entry?.speaker });
            });
            break;
        case 'edit':
            openEditForm(item, word, ctx.refresh);
            break;
        case 'delete':
            removeFromWordbook([word]);
            ctx.refresh();
            break;
        case 'known':
            setKnown([word], !loadWordbook().find(w => w.word === word)?.known);
            ctx.refresh();
            break;
        case 'filter-pos': {
            const pos = action.dataset.pos ?? '';
            ctx.filter.pos = ctx.filter.pos === pos ? '' : pos;
            ctx.refresh();
            break;
        }
        case 'conjugate':
            showConjugationPopupFromCache(word, { ai, getLang, getNativeLang });
            break;
        case 'note':
            toggleNoteEditor(noteParts(item), word);
            break;
        case 'note-preview': {
            const parts = noteParts(item);
            if (!isNoteEditorOpen(parts.editor))
                openNoteEditor(parts, word);
            break;
        }
        case 'context': {
            const entry = loadWordbook().find(w => w.word === word);
            if (entry?.context_meaning)
                togglePopover(action, entry.original_form ?? '', entry.context_meaning);
            break;
        }
    }
}
function onChange(listEl, e) {
    const input = e.target;
    const word = input.closest('.pg-wordbook-item')?.dataset.word;
    if (input.dataset.set && word)
        toggleWordInSet(word, input.dataset.set);
    if (input.classList.contains('pg-wb-row-chk'))
        contexts.get(listEl)?.onSelect();
}
// ── Public API ────────────────────────────────────────────────────────────────
/** Renders the filtered list into `listEl`, keeping its scroll position. Returns [shown, total, known words hidden]. */
export function renderList(listEl, ctx) {
    const wordbook = scopedWordbook();
    const hideKnown = getSettings().wordbook_hide_known !== false;
    const shown = applyFilter(wordbook, ctx.filter, hideKnown);
    const hidden = hideKnown ? wordbook.filter(w => hiddenAsKnown(w, ctx.filter, true)).length : 0;
    const scroll = listEl.scrollTop;
    if (!contexts.has(listEl)) {
        listEl.addEventListener('click', e => onClick(listEl, e));
        listEl.addEventListener('change', e => onChange(listEl, e));
        // Icons acting as buttons (a sentence's ▶) are pressed with Enter or Space too
        listEl.addEventListener('keydown', e => {
            const el = e.target;
            if ((e.key === 'Enter' || e.key === ' ') && el.matches('[role="button"][data-action]')) {
                e.preventDefault();
                el.click();
            }
        });
    }
    contexts.set(listEl, ctx);
    const key = JSON.stringify(ctx.filter);
    const page = paging.get(listEl)?.key === key ? paging.get(listEl) : { key, limit: PAGE_SIZE };
    paging.set(listEl, page);
    const rest = shown.length - page.limit;
    setHtml(listEl, shown.length
        ? html `${shown.slice(0, page.limit).map(w => row(w, ctx))}
               ${rest > 0 && html `<button class="pg-btn pg-btn-secondary pg-btn-block pg-wb-more">${t('wb.showMore', { n: Math.min(rest, PAGE_SIZE), rest })}</button>`}`
        : html `<div class="pg-empty-hint">${emptyMessage(wordbook.length, ctx.filter.query, hidden)}</div>`);
    listEl.scrollTop = scroll;
    return [shown.length, wordbook.length, hidden];
}
/** The count label: "N words", "shown / total" while filtered, or with the known words hidden. */
export function countLabel([shown, total, hidden = 0], filter) {
    if (isFiltered(filter))
        return `${shown} / ${total}`;
    return hidden ? t('wb.nWordsHidden', { n: shown, k: hidden }) : t('wb.nWords', { n: total });
}
/** Words whose row checkbox is ticked. */
export function selectedWords(listEl) {
    return [...listEl.querySelectorAll('.pg-wb-row-chk:checked')].map(c => c.dataset.word ?? '').filter(Boolean);
}
