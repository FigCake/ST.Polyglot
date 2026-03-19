// ════════════════════════════
// Polyglot  ui/wordbook-ui.ts
// ════════════════════════════
// Wordbook tab UI — list, filters, sets, import/export.
//
// Design rules:
//   • No direct ST state reads.  callModel / getLang / getNativeLang / speak
//     are injected via WbUiDeps.
//   • showConjugationPopupFromCache and deleteConjCache are imported directly
//     (no index.ts dependency).
//   • wbFilter is module-level state.  renderWordbook() always reads it fresh,
//     so filter changes just call renderWordbook(container) again.
//   • renderWordbook() is exported so index.ts can trigger panel refreshes
//     from addToWordbook() without a circular import.
//
// Dependencies: constants.ts, types.ts, utils.ts, ui.manager.ts,
//               wordbook.ts, conj-cache.ts, features/conjugation.ts
import { LEVEL_FILTERS, SRS as SRS_CFG, CEFR_LEVELS, dictUrl, POS_LABELS } from '../constants.js';
import { levelClass, levelLabel } from '../utils.js';
import { escapeHtml, notify, askConfirm, askInput } from '../ui.manager.js';
import { loadWordbook, saveWordbook, getSets, createSet, deleteSet, toggleWordInSet, splitCsvLines, addToWordbook as _wbAddEntry, } from '../wordbook.js';
import { deleteConjCache } from '../conj-cache.js';
import { showConjugationPopupFromCache } from '../features/conjugation.js';
import { runReanalysis, abortReanalysis } from '../features/reanalysis.js';
import { runQuickLookup } from './tap-translate.js';
import { t, currentLang } from '../i18n.js';
let _deps = null;
export function initWbUI(deps) {
    _deps = deps;
    // Close the context popover when clicking outside of it
    document.addEventListener('click', e => {
        if (_wbPopover && !_wbPopover.contains(e.target))
            removeWbPopover();
    });
}
// ── Module-level filter state ─────────────────────────────────────────────────
/** Persists across renderWordbook re-renders within the same panel session. */
const wbFilter = { level: 'all', setId: 'all', query: '', pos: '' };
let _wbPopover = null;
export function showWbPopover(anchorEl, originalForm, contextMeaning) {
    removeWbPopover();
    const pop = document.createElement('div');
    pop.className = 'pg-wb-popover';
    pop.innerHTML = `
        <div class="pg-wb-popover-word">${escapeHtml(originalForm)}</div>
        <div class="pg-wb-popover-meaning">${escapeHtml(contextMeaning)}</div>`;
    document.body.appendChild(pop);
    _wbPopover = pop;
    _wbPopover._anchor = anchorEl;
    const rect = anchorEl.getBoundingClientRect();
    const popW = pop.offsetWidth || 200;
    const popH = pop.offsetHeight || 60;
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + popW > window.innerWidth - 8)
        left = window.innerWidth - popW - 8;
    if (left < 4)
        left = 4;
    if (top + popH > window.innerHeight - 8)
        top = rect.top - popH - 4;
    if (top < 4)
        top = 4;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    requestAnimationFrame(() => pop.classList.add('pg-wb-popover-visible'));
}
export function removeWbPopover() {
    if (_wbPopover) {
        _wbPopover.remove();
        _wbPopover = null;
    }
}
// ── Bulk action bar ───────────────────────────────────────────────────────────
function _updateBulkBar(container) {
    if (!container)
        return;
    const checked = container.querySelectorAll('.pg-wb-row-chk:checked');
    const selCount = container.querySelector('#pg-wb-sel-count');
    const delBtn = container.querySelector('#pg-wb-del-sel');
    const reselBtn = container.querySelector('#pg-wb-reanalyse-sel');
    const selAll = container.querySelector('#pg-wb-sel-all');
    const n = checked.length;
    const total = container.querySelectorAll('.pg-wb-row-chk').length;
    const show = n > 0;
    const countEl = container.querySelector('#pg-wb-count');
    if (countEl)
        countEl.style.display = show ? 'none' : '';
    if (selCount) {
        selCount.textContent = t('wb.nSelected', { n, total });
        selCount.style.display = show ? '' : 'none';
    }
    if (delBtn)
        delBtn.style.display = show ? '' : 'none';
    if (reselBtn)
        reselBtn.style.display = show ? '' : 'none';
    if (selAll) {
        selAll.textContent = total > 0 && n === total ? t('wb.deselectAll') : t('wb.selectAll');
    }
}
// ── Main wordbook renderer ────────────────────────────────────────────────────
export function renderWordbook(container) {
    const listEl_ = container.querySelector('#pg-wb-list');
    const savedScroll = listEl_ ? listEl_.scrollTop : 0;
    // Reset search query when the wordbook tab is freshly opened (no list yet),
    // but preserve it across re-renders within the same panel session (e.g. after
    // adding a word or changing a filter) so the user's search is not lost.
    if (!listEl_)
        wbFilter.query = '';
    const wordbook = loadWordbook();
    const sets = getSets();
    // ── Filter bar (level pills)
    const levelFilters = [...LEVEL_FILTERS, 'sentence'];
    const levelHtml = levelFilters.map(l => `<button class="pg-filter-pill ${wbFilter.level === l ? 'active' : ''}" data-level="${l}">
            ${l === 'all' ? t('wb.filterAll') : levelLabel(l)}
         </button>`).join('');
    const setOptions = `
        <option value="all">${t('wb.allSets')}</option>
        ${sets.map(s => `<option value="${s.id}" ${wbFilter.setId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}`;
    container.innerHTML = `
        <div id="pg-wb-reanalysis-bar" class="pg-reanalysis-bar" style="display:none;"></div>

        <!-- Search bar -->
        <div class="pg-wb-search-row">
            <input type="search" id="pg-wb-search" class="pg-wb-search-inp"
                placeholder="${t('wb.searchPh')}"
                value="${escapeHtml(wbFilter.query)}">
            ${wbFilter.query ? `<button id="pg-wb-search-clear" class="pg-wb-search-clear" title="${t('wb.clearSearch')}">✕</button>` : ''}
        </div>

        <div class="pg-wb-filters">
            <div class="pg-filter-pills">${levelHtml}</div>
            <div class="pg-wb-set-row">
                <select id="pg-wb-set-sel" class="pg-set-select">${setOptions}</select>
                <button id="pg-wb-set-new" class="pg-icon-btn" title="${t('wb.newSetTitle')}"><i class="fa-solid fa-plus"></i></button>
            </div>
        </div>
        <div class="pg-wb-count-row">
            <span id="pg-wb-count"></span>
            <span id="pg-wb-sel-count" style="display:none;"></span>
            <button id="pg-wb-del-sel" class="pg-wb-row-btn pg-wb-row-btn-danger" style="display:none;">${t('wb.delete')}</button>
            <button id="pg-wb-reanalyse-sel" class="pg-wb-row-btn" style="display:none;">${t('wb.reanalyse')}</button>
            <span class="pg-wb-count-spacer"></span>
            <button id="pg-wb-sel-all" class="pg-wb-row-btn">${t('wb.selectAll')}</button>
        </div>
        <div id="pg-wb-list">${_skeletonWbList(4)}</div>
        <div id="pg-set-manager" class="pg-set-manager"></div>`;
    // ── Search
    const searchInp = container.querySelector('#pg-wb-search');
    searchInp?.addEventListener('input', () => {
        wbFilter.query = searchInp.value;
        // Update only the list — do NOT re-render the whole panel (would steal focus)
        _renderListOnly(container);
    });
    container.querySelector('#pg-wb-search-clear')?.addEventListener('click', () => {
        wbFilter.query = '';
        renderWordbook(container); // full re-render to remove the ✕ button
    });
    // ── Level filter pills
    container.querySelectorAll('.pg-filter-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            wbFilter.level = pill.dataset.level ?? '';
            wbFilter.pos = ''; // clear POS chip filter to avoid conflicting filters
            renderWordbook(container);
        });
    });
    // ── Set filter
    container.querySelector('#pg-wb-set-sel')?.addEventListener('change', e => {
        wbFilter.setId = e.target.value;
        renderWordbook(container);
    });
    // ── New set
    container.querySelector('#pg-wb-set-new')?.addEventListener('click', async () => {
        const name = (await askInput(t('wb.newSet'), { hint: t('wb.newSetHint') }))?.trim();
        if (name) {
            createSet(name);
            renderWordbook(container);
        }
    });
    // ── AI Re-analysis (selected words — full reanalysis is in settings tab)
    container.querySelector('#pg-wb-reanalyse-sel')?.addEventListener('click', () => {
        const selected = [...container.querySelectorAll('.pg-wb-row-chk:checked')]
            .map(c => c.dataset.word ?? '').filter(Boolean);
        if (!selected.length)
            return;
        _startReanalysis(container, selected);
    });
    // ── Bulk select / delete
    container.querySelector('#pg-wb-sel-all')?.addEventListener('click', () => {
        const allChks = container.querySelectorAll('.pg-wb-row-chk');
        const allChecked = [...allChks].every(c => c.checked);
        allChks.forEach(c => { c.checked = !allChecked; });
        _updateBulkBar(container);
    });
    container.querySelector('#pg-wb-del-sel')?.addEventListener('click', async () => {
        const selected = [...container.querySelectorAll('.pg-wb-row-chk:checked')]
            .map(c => c.dataset.word ?? '');
        if (!selected.length)
            return;
        const ok = await askConfirm(t('wb.delConfirm', { n: selected.length }), { yes: t('wb.delSetBtn') });
        if (!ok)
            return;
        const wb = loadWordbook().filter(w => !selected.includes(w.word));
        saveWordbook(wb);
        renderWordbook(container);
    });
    // ── Set manager + word list
    renderSetManager(container.querySelector('#pg-set-manager'), sets, container);
    renderWbList(container.querySelector('#pg-wb-list'), wordbook, sets, savedScroll);
}
/** Starts a reanalysis run and wires the progress bar UI.
 *  @param words — if provided, only these words are reanalysed (selected-only mode).
 */
async function _startReanalysis(container, words) {
    if (!_deps) {
        return;
    }
    const wb = loadWordbook();
    const pool = words
        ? wb.filter(e => words.includes(e.word))
        : wb.filter(e => e.level !== 'grammar' && e.level !== 'sentence');
    const total = pool.length;
    if (total === 0) {
        notify(t('wb.reanalyseNone'), 'warn');
        return;
    }
    const ok = await askConfirm(t('wb.reanalyseConfirm', { n: total }), { yes: t('wb.reanalyseStart'), no: t('confirmNo') });
    if (!ok)
        return;
    const bar = container.querySelector('#pg-wb-reanalysis-bar');
    const reBtn = container.querySelector('#pg-wb-reanalyse');
    const showBar = (text, pct) => {
        if (!bar)
            return;
        bar.style.display = '';
        bar.innerHTML = `
            <div class="pg-reanalysis-progress">
                <span class="pg-reanalysis-text">${escapeHtml(text)}</span>
                <button class="pg-reanalysis-stop" id="pg-wb-reanalyse-stop">${t('ann.stop')}</button>
            </div>
            <div class="pg-reanalysis-track">
                <div class="pg-reanalysis-fill" style="width:${pct}%"></div>
            </div>`;
        bar.querySelector('#pg-wb-reanalyse-stop')?.addEventListener('click', () => {
            abortReanalysis();
        });
    };
    const hideBar = () => {
        if (bar)
            bar.style.display = 'none';
        if (reBtn)
            reBtn.textContent = `✨ ${t('wb.reanalyse')}`;
    };
    if (reBtn)
        reBtn.textContent = t('wb.reanalysing');
    showBar(t('wb.reanalyseProgress', { done: 0, total }), 0);
    await runReanalysis({
        callModel: _deps.callModel,
        getLang: _deps.getLang,
        getNativeLang: _deps.getNativeLang,
    }, {
        words,
        onProgress(index, tot, word) {
            const pct = tot > 0 ? Math.round((index / tot) * 100) : 0;
            showBar(t('wb.reanalyseProgress', { done: index, total: tot, word }), pct);
        },
        onDone(processed, tot, aborted) {
            hideBar();
            const msg = aborted
                ? t('wb.reanalyseStopped', { done: processed, total: tot })
                : t('wb.reanalyseDone', { n: processed });
            notify(msg, aborted ? 'warn' : 'ok', 3000);
            // Refresh the list so new pos/ipa/collocation chips appear
            _renderListOnly(container);
        },
    });
}
/** Skeleton placeholder rows for the wordbook list while loading. */
function _skeletonWbList(n = 4) {
    const widths = ['72%', '58%', '80%', '65%', '70%', '55%'];
    return Array.from({ length: n }, (_, i) => `
        <div class="pg-skeleton-wb-item pg-skeleton">
            <div class="pg-skeleton-line pg-skeleton" style="width:${widths[i % 3]};"></div>
            <div class="pg-skeleton-line-sm pg-skeleton" style="width:${widths[(i + 2) % 6]};"></div>
        </div>`).join('');
}
/**
 * Opens an inline note editor inside a wordbook row.
 * Saves on blur or Ctrl/Cmd+Enter; cancels on Escape.
 * Updates the preview and note button state in-place without re-rendering.
 */
function _openNoteEditor(editor, preview, noteBtn, word) {
    const wb = loadWordbook();
    const entry = wb.find(e => e.word === word);
    const current = entry?.notes ?? '';
    // Hide preview while editing
    if (preview)
        preview.style.display = 'none';
    editor.style.display = '';
    editor.innerHTML = `
        <textarea class="pg-wb-note-textarea"
            placeholder="${t('wb.notePh')}"
            rows="3">${escapeHtml(current)}</textarea>
        <div class="pg-wb-note-actions">
            <span class="pg-wb-note-hint">${t('wb.noteHint')}</span>
            <button class="pg-wb-note-cancel pg-wb-row-btn">${t('wb.noteCancel')}</button>
            <button class="pg-wb-note-save  pg-wb-row-btn pg-wb-note-save-btn">${t('wb.noteSave')}</button>
        </div>`;
    const textarea = editor.querySelector('.pg-wb-note-textarea');
    if (!textarea)
        return;
    textarea.focus();
    // Place cursor at end
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    // cancelled flag prevents the blur handler from saving after an explicit cancel
    let cancelled = false;
    const save = () => {
        if (cancelled)
            return;
        const text = textarea.value.trim();
        const fresh = loadWordbook();
        const target = fresh.find(e => e.word === word);
        if (target) {
            target.notes = text || undefined;
            saveWordbook(fresh);
        }
        // Update preview in-place
        if (preview) {
            preview.textContent = text;
            preview.style.display = text ? '' : 'none';
        }
        // Update note button accent
        if (noteBtn)
            noteBtn.classList.toggle('pg-wb-note-btn-has', !!text);
        editor.style.display = 'none';
    };
    const cancel = () => {
        cancelled = true;
        editor.style.display = 'none';
        if (preview)
            preview.style.display = current ? '' : 'none';
    };
    editor.querySelector('.pg-wb-note-save')?.addEventListener('click', e => {
        e.stopPropagation();
        save();
    });
    editor.querySelector('.pg-wb-note-cancel')?.addEventListener('click', e => {
        e.stopPropagation();
        cancel();
    });
    textarea.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancel();
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
        }
    });
    // Save on blur — delayed so Save/Cancel button clicks register first.
    // The cancelled flag ensures cancel() prevents this from running.
    textarea.addEventListener('blur', () => setTimeout(save, 150));
}
/** Partial re-render: updates only the word list and count, without touching
 *  the search input or filter bar. Used by the search input handler so that
 *  focus is never stolen mid-typing.
 */
function _renderListOnly(container) {
    const listEl = container.querySelector('#pg-wb-list');
    if (!listEl) {
        renderWordbook(container);
        return;
    }
    const savedScroll = listEl.scrollTop;
    const wordbook = loadWordbook();
    const sets = getSets();
    renderWbList(listEl, wordbook, sets, savedScroll);
}
// ── Word list renderer ────────────────────────────────────────────────────────
export function renderWbList(listEl, wordbook, sets, savedScroll = 0) {
    // ── Apply filters
    let filtered = wordbook.slice();
    // Level filter
    if (wbFilter.level !== 'all') {
        filtered = wbFilter.level === 'grammar'
            ? filtered.filter(w => !w.level || w.level === 'grammar')
            : wbFilter.level === 'sentence'
                ? filtered.filter(w => w.level === 'sentence')
                : filtered.filter(w => w.level === wbFilter.level);
    }
    // POS filter — set by clicking a pos badge chip on a word row
    if (wbFilter.pos) {
        filtered = filtered.filter(w => w.pos === wbFilter.pos);
    }
    // Set filter
    if (wbFilter.setId !== 'all') {
        filtered = filtered.filter(w => (w.setIds || []).includes(wbFilter.setId));
    }
    // ★ Search filter — matches word, base_form, meaning, collocations, or notes (case-insensitive)
    const q = wbFilter.query.trim().toLowerCase();
    if (q) {
        filtered = filtered.filter(w => w.word.toLowerCase().includes(q) ||
            (w.base_form ?? '').toLowerCase().includes(q) ||
            (w.meaning ?? '').toLowerCase().includes(q) ||
            (w.collocations ?? []).some(c => c.toLowerCase().includes(q)) ||
            (w.notes ?? '').toLowerCase().includes(q));
    }
    // ── Count display
    const countEl = listEl.parentElement?.querySelector('#pg-wb-count');
    if (countEl) {
        const total = wordbook.length;
        const shown = filtered.length;
        const isFiltered = wbFilter.level !== 'all' || wbFilter.setId !== 'all' || q || wbFilter.pos;
        countEl.textContent = isFiltered ? `${shown} / ${total}` : t('wb.nWords', { n: total });
    }
    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="pg-empty-hint">${wordbook.length === 0
            ? t('wb.empty')
            : q
                ? t('wb.noMatchSearch', { q })
                : t('wb.noMatch')}</div>`;
        return;
    }
    listEl.innerHTML = '';
    filtered.slice().reverse().forEach(w => {
        const item = document.createElement('div');
        item.className = 'pg-wordbook-item';
        const setChecks = sets.map(s => `<label class="pg-set-check" title="${escapeHtml(s.name)}">
                <input type="checkbox" data-word="${escapeHtml(w.word)}" data-set="${s.id}"
                    ${(w.setIds || []).includes(s.id) ? 'checked' : ''}>
                <span>${escapeHtml(s.name)}</span>
             </label>`).join('');
        const dateStr = w.dateAdded
            ? new Date(w.dateAdded).toLocaleDateString(currentLang(), { month: 'short', day: 'numeric' })
            : '';
        // ★ If a search query is active, highlight the match inside word and meaning
        const wordDisplay = q ? _highlightMatch(w.word, q) : escapeHtml(w.word);
        const meaningDisplay = q ? _highlightMatch(w.meaning, q) : escapeHtml(w.meaning);
        // ── POS badge chip (clickable — toggles pos filter)
        const posChipHtml = w.pos && POS_LABELS[w.pos]
            ? `<button class="pg-pos-chip${wbFilter.pos === w.pos ? ' pg-pos-chip-active' : ''}"
                       data-pos="${escapeHtml(w.pos)}"
                       title="${t('wb.filterByPos')}">${escapeHtml(POS_LABELS[w.pos])}</button>`
            : '';
        // ── IPA chip (display only)
        const ipaHtml = w.ipa
            ? `<span class="pg-ipa-chip">${escapeHtml(w.ipa)}</span>`
            : '';
        // ── Collocations chips (display only)
        const collocHtml = (w.collocations?.length)
            ? `<div class="pg-colloc-row">${w.collocations.map(c => `<span class="pg-colloc-chip">${escapeHtml(c)}</span>`).join('')}</div>`
            : '';
        item.innerHTML = `
            <div class="pg-wb-head">
                <div class="pg-wb-head-left">
                    <input type="checkbox" class="pg-wb-row-chk" data-word="${escapeHtml(w.word)}" title="${t('wb.selectRow')}">
                    <strong>${wordDisplay}</strong>
                    ${posChipHtml}
                </div>
                <div class="pg-wb-head-right">
                    <button class="pg-icon-btn pg-speak-btn" data-speak="${escapeHtml(w.word)}" title="${t('wb.listen')}">🔊</button>
                    <button class="pg-icon-btn pg-wb-del" data-word="${escapeHtml(w.word)}" title="${t('wb.deleteWord')}">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="pg-wb-mean">${meaningDisplay}</div>
            <div class="pg-wb-meta">
                ${ipaHtml}
                <span class="pg-level-badge level-${levelClass(w.level || 'grammar')}">${escapeHtml(levelLabel(w.level))}</span>
                ${w.conj_cached ? `<button class="pg-icon-btn pg-wb-conj-btn" data-word="${escapeHtml(w.word)}" title="${t('wb.conjTable')}">📊</button>` : ''}
                <button class="pg-icon-btn pg-wb-note-btn${w.notes ? ' pg-wb-note-btn-has' : ''}" data-word="${escapeHtml(w.word)}" title="${t('wb.noteTitle')}">📝</button>
                ${dateStr ? `<span class="pg-wb-date">${dateStr}</span>` : ''}
            </div>
            <div class="pg-wb-secondary" aria-hidden="true">
                ${w.pos_info ? `<div class="pg-wb-pos-info">${escapeHtml(w.pos_info)}</div>` : ''}
                ${w.original_form ? `<button class="pg-wb-ctx-btn" data-word="${escapeHtml(w.word)}" title="${t('wb.viewCtx')}">${escapeHtml(w.original_form)}</button>` : ''}
                ${collocHtml}
                ${sets.length > 0 ? `<div class="pg-set-checks">${setChecks}</div>` : ''}
            </div>
            ${w.notes ? `<div class="pg-wb-notes-preview" data-word="${escapeHtml(w.word)}">${escapeHtml(w.notes)}</div>` : ''}
            <div class="pg-wb-note-editor" data-word="${escapeHtml(w.word)}" style="display:none;"></div>`;
        listEl.appendChild(item);
    });
    // ── Event bindings
    // ── Wordbook item click — toggle secondary info (collocations, sets, date)
    listEl.querySelectorAll('.pg-wordbook-item').forEach(item => {
        item.addEventListener('click', e => {
            // Don't toggle when clicking buttons/chips/inputs inside the item
            const target = e.target;
            if (target.closest('button, input, a, select'))
                return;
            const sec = item.querySelector('.pg-wb-secondary');
            if (!sec)
                return;
            const open = item.classList.toggle('pg-wb-expanded');
            sec.setAttribute('aria-hidden', String(!open));
        });
    });
    // ── Note button — opens/closes inline note editor
    listEl.querySelectorAll('.pg-wb-note-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const word = btn.dataset.word ?? '';
            const item = btn.closest('.pg-wordbook-item');
            if (!item)
                return;
            const editor = item.querySelector('.pg-wb-note-editor');
            const preview = item.querySelector('.pg-wb-notes-preview');
            if (!editor)
                return;
            // Toggle: if editor already open, close it
            if (editor.style.display !== 'none') {
                editor.style.display = 'none';
                if (preview)
                    preview.style.display = '';
                return;
            }
            _openNoteEditor(editor, preview, btn, word);
        });
    });
    // Note preview click — also opens the editor
    listEl.querySelectorAll('.pg-wb-notes-preview').forEach(preview => {
        preview.addEventListener('click', e => {
            e.stopPropagation();
            const word = preview.dataset.word ?? '';
            const item = preview.closest('.pg-wordbook-item');
            if (!item)
                return;
            const editor = item.querySelector('.pg-wb-note-editor');
            const noteBtn = item.querySelector('.pg-wb-note-btn');
            if (!editor || editor.style.display !== 'none')
                return;
            _openNoteEditor(editor, preview, noteBtn, word);
        });
    });
    // POS chip — click to filter by POS, click again to clear
    listEl.querySelectorAll('.pg-pos-chip').forEach(chip => {
        chip.addEventListener('click', e => {
            e.stopPropagation();
            const pos = chip.dataset.pos ?? '';
            // Toggle: clicking the active filter clears it
            wbFilter.pos = wbFilter.pos === pos ? '' : pos;
            const container = listEl.closest('.pg-box-pane');
            if (container)
                renderWordbook(container);
        });
    });
    // Conjugation table popup
    listEl.querySelectorAll('.pg-wb-conj-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const word = btn.dataset.word;
            if (word)
                showConjugationPopupFromCache(word, {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    callModel: _deps.callModel.bind(_deps),
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    getLang: _deps.getLang,
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    getNativeLang: _deps.getNativeLang,
                });
        });
    });
    // Context popover
    listEl.querySelectorAll('.pg-wb-ctx-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            if (_wbPopover && _wbPopover._anchor === btn) {
                removeWbPopover();
                return;
            }
            const entry = loadWordbook().find(w => w.word === btn.dataset.word);
            if (!entry?.context_meaning)
                return;
            showWbPopover(btn, entry.original_form ?? '', entry.context_meaning);
        });
    });
    // Pronunciation
    listEl.querySelectorAll('.pg-speak-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            _deps?.speak(btn.dataset.speak ?? '', _deps.getLang());
        });
    });
    // Delete
    listEl.querySelectorAll('.pg-wb-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const word = btn.dataset.word;
            const wb = loadWordbook().filter(w => w.word !== word);
            saveWordbook(wb);
            if (word)
                deleteConjCache(word);
            const container = listEl.closest('.pg-box-pane');
            if (container)
                renderWordbook(container);
        });
    });
    // Set checkboxes
    listEl.querySelectorAll('.pg-set-check input').forEach(chk => {
        chk.addEventListener('change', () => { if (chk.dataset.word && chk.dataset.set)
            toggleWordInSet(chk.dataset.word, chk.dataset.set); });
    });
    // Row selection → bulk bar
    const container_ = listEl.closest('.pg-box-pane');
    listEl.querySelectorAll('.pg-wb-row-chk').forEach(chk => {
        chk.addEventListener('change', () => _updateBulkBar(container_));
    });
    listEl.scrollTop = savedScroll;
}
// ── Set manager renderer ──────────────────────────────────────────────────────
export function renderSetManager(el, sets, container) {
    if (sets.length === 0) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = `
        <div class="pg-set-manager-title">${t('wb.manageSets')}</div>
        ${sets.map(s => `
            <div class="pg-set-row">
                <span class="pg-set-name">${escapeHtml(s.name)}</span>
                <button class="pg-icon-btn pg-set-del" data-id="${s.id}" title="${t('wb.deleteSet')}">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>`).join('')}`;
    el.querySelectorAll('.pg-set-del').forEach(btn => {
        btn.addEventListener('click', async () => {
            const setName = getSets().find(s => s.id === btn.dataset.id)?.name ?? '';
            const ok = await askConfirm(t('wb.delSet', { name: setName }), { yes: t('wb.delSetBtn') });
            if (!ok)
                return;
            const setId = btn.dataset.id;
            if (setId)
                deleteSet(setId);
            if (wbFilter.setId === (btn.dataset.id ?? ''))
                wbFilter.setId = 'all';
            renderWordbook(container);
        });
    });
}
// ── Import (auto-detecting CSV & TXT parser) ──────────────────────────────────
export function triggerImport(container) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.txt';
    input.onchange = e => {
        const file = e.target.files?.[0];
        if (!file)
            return;
        const reader = new FileReader();
        reader.onload = ev => {
            const result = ev.target.result;
            if (typeof result === 'string')
                processImportedFile(result, file.name, container);
        };
        reader.onerror = () => notify(t('wb.importFail'), 'err');
        reader.readAsText(file, 'UTF-8');
    };
    input.click();
}
export function processImportedFile(text, filename, container) {
    const setName = filename.replace(/\.(csv|txt)$/i, '');
    let setId = null;
    const isTab = text.includes('\t');
    const lines = isTab ? text.split('\n') : splitCsvLines(text);
    const wordbook = loadWordbook();
    let added = 0;
    const clean = (str) => {
        if (!str)
            return '';
        return str.replace(/^"|"$/g, '').replace(/<img[^>]*>/gi, '').replace(/\[sound:[^\]]*\]/gi, '').trim();
    };
    const stripHtml = (str) => {
        if (!str)
            return '';
        return str
            .replace(/<br\s*\/?>\s*/gi, ' ').replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
            .replace(/\s+/g, ' ').trim();
    };
    const extractBase = (str) => {
        if (!str)
            return '';
        const m = str.match(/Base:\s*([^<]+)/i);
        return m ? m[1].trim() : '';
    };
    const VALID_LEVELS = new Set([...CEFR_LEVELS, 'grammar', 'sentence']);
    const normaliseLevel = (str) => {
        if (!str)
            return 'A1';
        const upper = str.trim().toUpperCase();
        if (VALID_LEVELS.has(upper))
            return upper;
        if (VALID_LEVELS.has(str.trim()))
            return str.trim();
        return 'A1';
    };
    const parseCSV = (line) => {
        const ret = [];
        let cur = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') {
                if (inQ && line[i + 1] === '"') {
                    cur += '"';
                    i++;
                }
                else
                    inQ = !inQ;
            }
            else if (c === ',' && !inQ) {
                ret.push(cur);
                cur = '';
            }
            else
                cur += c;
        }
        ret.push(cur);
        return ret;
    };
    let updated = 0;
    for (const line of lines) {
        if (!line.trim() || line.startsWith('#'))
            continue;
        if (/^["']?word["']?[,\t]/i.test(line.trim()))
            continue;
        const cols = isTab ? line.split('\t') : parseCSV(line);
        if (cols.length < 2)
            continue;
        const word = clean(cols[0]);
        if (!word)
            continue;
        const rawMeaning = clean(cols[1]);
        if (!rawMeaning)
            continue;
        const baseFromHtml = extractBase(rawMeaning);
        const meaning = stripHtml(rawMeaning).replace(/\s*Base:[^.]*$/i, '').trim();
        const level = cols.length > 2 ? normaliseLevel(clean(cols[2])) : 'A1';
        const base_form = baseFromHtml || word;
        const colOffset = isTab ? 1 : 0;
        const original_form = cols.length > 3 + colOffset ? clean(cols[3 + colOffset]) || undefined : undefined;
        const context_meaning = cols.length > 4 + colOffset ? clean(cols[4 + colOffset]) || undefined : undefined;
        if (!setId)
            setId = createSet(setName);
        const existing = wordbook.find(w => w.word === word);
        if (existing) {
            if (!existing.setIds)
                existing.setIds = [];
            if (!existing.setIds.includes(setId)) {
                existing.setIds.push(setId);
                updated++;
            }
        }
        else {
            wordbook.push({
                word, base_form, meaning,
                meaning_lang: _deps?.getNativeLang() || undefined,
                level, original_form, context_meaning,
                setIds: [setId],
                dateAdded: new Date().toISOString(),
                srs_interval: SRS_CFG.initialInterval,
                srs_ease: SRS_CFG.defaultEase,
                srs_due: Date.now(),
            });
            added++;
        }
    }
    if (added === 0 && updated === 0) {
        if (setId)
            deleteSet(setId);
        notify(t('wb.importNone'), 'warn');
        return;
    }
    saveWordbook(wordbook);
    const msg = added > 0 && updated > 0
        ? t('wb.importBoth', { added, updated, set: setName })
        : added > 0
            ? t('wb.importNew', { n: added, set: setName })
            : t('wb.importUpdate', { n: updated, set: setName });
    notify(msg, 'ok', 4000);
    if (setId)
        wbFilter.setId = setId;
    renderWordbook(container);
}
// ── Internal: search match highlighter ───────────────────────────────────────
/**
 * Returns HTML with the first occurrence of `query` wrapped in <mark>.
 * XSS-safe: escapes both the full string AND the query before comparison,
 * so special characters like &, <, > are correctly matched and sliced
 * within the already-escaped output without breaking HTML entities.
 */
function _highlightMatch(text, query) {
    if (!text)
        return '';
    const escaped = escapeHtml(text);
    const escapedQuery = escapeHtml(query); // ← query도 escape 후 비교
    const idx = escaped.toLowerCase().indexOf(escapedQuery.toLowerCase());
    if (idx === -1)
        return escaped;
    return (escaped.slice(0, idx) +
        `<mark class="pg-wb-hl">${escaped.slice(idx, idx + escapedQuery.length)}</mark>` +
        escaped.slice(idx + escapedQuery.length));
}
// ── Detail tab renderer ───────────────────────────────────────────────────────
/** Renders word/grammar detail into the Detail tab container. */
export function renderDetailTab(container, wordData) {
    if (!wordData) {
        container.innerHTML = `<div class="pg-empty-hint">${t('det.hint').replace(/\n/g, '<br>')}</div>`;
        return;
    }
    if (wordData.type === 'loading') {
        container.innerHTML = `
            <div class="pg-word-detail-header">
                <div class="pg-skeleton" style="height:28px;width:50%;border-radius:8px;"></div>
            </div>
            <div class="pg-skeleton" style="height:10px;width:35%;border-radius:5px;margin:8px 0 14px;"></div>
            <div class="pg-skeleton" style="height:13px;width:90%;border-radius:6px;margin-bottom:7px;"></div>
            <div class="pg-skeleton" style="height:13px;width:75%;border-radius:6px;margin-bottom:7px;"></div>
            <div class="pg-skeleton" style="height:13px;width:82%;border-radius:6px;margin-bottom:18px;"></div>
            <div class="pg-skeleton" style="height:36px;width:100%;border-radius:100px;"></div>`;
        return;
    }
    if (wordData.type === 'error') {
        container.innerHTML = `
            <div class="pg-word-detail-header"><h2>${escapeHtml(wordData.word)}</h2></div>
            <div class="pg-error-msg">${t('det.failed')} ${escapeHtml(wordData.message)}</div>
            <button id="pg-btn-retry" class="pg-btn pg-btn-secondary pg-btn-full">${t('det.retry')}</button>`;
        container.querySelector('#pg-btn-retry').onclick = () => runQuickLookup(wordData.word, '');
        return;
    }
    if (wordData.type === 'word') {
        const w = wordData.data;
        const canonical = (w.base_form?.trim()) || w.word;
        const wbEntry = loadWordbook().find(e => e.word === canonical || e.word === w.word);
        const saved = !!wbEntry;
        // _deps may be null if the panel is opened before APP_READY (e.g. via a
        // slash command).  Fall back to safe defaults so the tab still renders.
        const s = _deps?.getSettings();
        const dUrl = s ? dictUrl(s.language, w.word, s.dict_url_custom) : null;
        const dictBtnHtml = dUrl
            ? `<a href="${escapeHtml(dUrl)}" target="_blank" class="pg-icon-btn pg-dict-btn" title="${t('tap.lookUp')}" style="text-decoration:none; display:inline-flex; align-items:center; justify-content:center;">📖</a>`
            : '';
        // Notes section — only shown when the word is already in the wordbook
        const notesHtml = saved ? `
            <div class="pg-det-notes-wrap" id="pg-det-notes-wrap">
                <div class="pg-det-notes-header">
                    <span class="pg-det-notes-label">${t('wb.noteLabel')}</span>
                    <button class="pg-icon-btn pg-det-note-edit" id="pg-det-note-edit" title="${t('wb.noteTitle')}">📝</button>
                </div>
                <div id="pg-det-notes-body">
                    ${wbEntry?.notes
            ? `<div class="pg-det-notes-text" id="pg-det-notes-text">${escapeHtml(wbEntry.notes)}</div>`
            : `<div class="pg-det-notes-empty" id="pg-det-notes-text">${t('wb.noteEmpty')}</div>`}
                </div>
                <div class="pg-wb-note-editor" id="pg-det-note-editor" style="display:none;"></div>
            </div>` : '';
        // Word family chips — shown when quickLookup returned related forms
        const familyHtml = (w.word_family?.length)
            ? `<div class="pg-det-family">
                   <span class="pg-det-family-label">${t('det.wordFamily')}</span>
                   <div class="pg-det-family-chips">
                       ${w.word_family.map(f => `<button class="pg-det-family-chip" data-word="${escapeHtml(f.form)}"
                                    title="${escapeHtml(f.meaning)}">
                                <span class="pg-det-family-form">${escapeHtml(f.form)}</span>
                                <span class="pg-det-family-pos">${escapeHtml(f.pos)}</span>
                            </button>`).join('')}
                   </div>
               </div>`
            : '';
        container.innerHTML = `
            <div class="pg-word-detail-header">
                <h2>${escapeHtml(w.word)}</h2>
                ${dictBtnHtml} <button class="pg-speak-btn" title="${t('wb.listen')}" data-speak="${escapeHtml(canonical)}">🔊</button>
                <span class="pg-level-badge level-${levelClass(w.level)}">${escapeHtml(levelLabel(w.level))}</span>
            </div>
            <div class="pg-word-meta">
                <span class="pg-meta-base">${escapeHtml(w.base_form || '')}</span>
                <span class="pg-meta-pos">${escapeHtml(w.pos_info || '')}</span>
            </div>
            <div class="pg-word-meaning">${escapeHtml(w.meaning)}</div>
            ${familyHtml}
            ${notesHtml}
            <button id="pg-btn-add-word" class="pg-btn pg-btn-primary pg-btn-full" ${saved ? 'disabled' : ''}>
                ${saved ? t('det.saved') : t('det.addWord')}
            </button>`;
        container.querySelector('.pg-speak-btn')?.addEventListener('click', () => _deps?.speak(canonical, _deps.getLang()));
        // Word family chip clicks — look up the related form immediately
        container.querySelectorAll('.pg-det-family-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const form = chip.dataset.word ?? '';
                if (form)
                    runQuickLookup(form, '');
            });
        });
        // Note edit button in detail tab
        if (saved) {
            container.querySelector('#pg-det-note-edit')?.addEventListener('click', () => {
                const editor = container.querySelector('#pg-det-note-editor');
                const preview = container.querySelector('#pg-det-notes-body');
                const noteBtn = container.querySelector('#pg-det-note-edit');
                if (!editor)
                    return;
                if (editor.style.display !== 'none') {
                    editor.style.display = 'none';
                    return;
                }
                _openNoteEditor(editor, preview, noteBtn, canonical);
            });
        }
        if (!saved) {
            const btn = container.querySelector('#pg-btn-add-word');
            if (btn)
                btn.onclick = () => {
                    addToWordbook(w);
                    btn.textContent = t('det.saved');
                    btn.disabled = true;
                };
        }
        return;
    }
    if (wordData.type === 'grammar') {
        const g = wordData.data;
        // Normalise for wordbook storage: word=pattern, level='grammar'
        const asWord = { word: g.pattern, base_form: g.words_used || '', pos_info: g.structure || '', meaning: g.meaning || '', level: 'grammar' };
        const saved = loadWordbook().some(e => e.word === g.pattern);
        container.innerHTML = `
            <div class="pg-word-detail-header">
                <h2>${escapeHtml(g.pattern)}</h2>
                <span class="pg-level-badge level-grammar">${t('det.gram')}</span>
            </div>
            <div class="pg-grammar-section"><span class="pg-g-label">${t('det.meaning')}</span>${escapeHtml(g.meaning || '')}</div>
            <div class="pg-grammar-section"><span class="pg-g-label">${t('det.structure')}</span>${escapeHtml(g.structure || '')}</div>
            <div class="pg-grammar-section"><span class="pg-g-label">${t('det.words')}</span>${escapeHtml(g.words_used || '')}</div>
            <button id="pg-btn-add-gram" class="pg-btn pg-btn-primary pg-btn-full" style="margin-top:10px;" ${saved ? 'disabled' : ''}>
                ${saved ? t('det.saved') : t('det.addGram')}
            </button>`;
        if (!saved) {
            const btn = container.querySelector('#pg-btn-add-gram');
            if (btn)
                btn.onclick = () => {
                    addToWordbook(asWord);
                    btn.textContent = t('det.saved');
                    btn.disabled = true;
                };
        }
        return;
    }
    if (wordData.type === 'idiom') {
        const id = wordData.data;
        const saved = loadWordbook().some(e => e.word === (id.base_form || id.phrase));
        container.innerHTML = `
            <div class="pg-word-detail-header">
                <h2>${escapeHtml(id.phrase)}</h2>
                <span class="pg-level-badge level-idiom">${t('det.idiom')}</span>
            </div>
            ${id.base_form && id.base_form !== id.phrase
            ? `<div class="pg-grammar-section"><span class="pg-g-label">${t('det.baseForm')}</span>${escapeHtml(id.base_form)}</div>`
            : ''}
            <div class="pg-grammar-section"><span class="pg-g-label">${t('det.meaning')}</span>${escapeHtml(id.meaning || '')}</div>
            ${id.context_meaning
            ? `<div class="pg-grammar-section"><span class="pg-g-label">${t('det.context')}</span>${escapeHtml(id.context_meaning)}</div>`
            : ''}
            <button id="pg-btn-add-idiom" class="pg-btn pg-btn-primary pg-btn-full" style="margin-top:10px;" ${saved ? 'disabled' : ''}>
                ${saved ? t('det.saved') : t('det.addToWb')}
            </button>`;
        if (!saved) {
            const btn = container.querySelector('#pg-btn-add-idiom');
            if (btn)
                btn.onclick = () => {
                    addToWordbook({
                        word: id.phrase,
                        base_form: id.base_form || id.phrase,
                        meaning: id.meaning,
                        level: 'idiom',
                        context_meaning: id.context_meaning,
                    });
                    btn.textContent = t('det.saved');
                    btn.disabled = true;
                };
        }
        return;
    }
}
// ── addToWordbook ─────────────────────────────────────────────────────────────
/** Adds a word to the wordbook and refreshes the wordbook panel if open. */
export function addToWordbook(wordData) {
    if (!wordData.meaning_lang && _deps) {
        const s = _deps.getSettings();
        wordData.meaning_lang = s.native_lang === 'custom'
            ? (s.native_lang_custom?.slice(0, 10) || 'custom')
            : (s.native_lang ?? 'en');
    }
    const added = _wbAddEntry(wordData);
    if (added) {
        const container = _deps?.getWbContainer();
        if (container)
            renderWordbook(container);
    }
}
