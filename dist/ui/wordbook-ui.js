// The Wordbook tab: search, level pills, set picker, selection toolbar, the
// word list and the set manager. Which words it lists (this chat, the study
// language) is set in the panel settings.
//
//   ui/wordbook/filters.ts      filter state → visible entries (pure)
//   ui/wordbook/list.ts         the rows and their actions
//   ui/wordbook/detail.ts       the Learn tab's detail card
//   ui/wordbook/import.ts       CSV / TXT import
//   ui/wordbook/note-editor.ts  inline notes
//   ui/wordbook/popover.ts      "seen as … meaning …" popover
//
// The tab remembers the element it was last rendered into (while the panel is
// open), so any module can call refreshWordbook() after changing data — even
// while another tab is showing and the wordbook is detached.
import { LEVEL_FILTERS } from '../constants.js';
import { levelLabel } from '../utils.js';
import { html, setHtml } from '../html.js';
import { t } from '../i18n.js';
import { askConfirm, askInput, notify } from '../ui.manager.js';
import { getSets, createSet, deleteSet, removeFromWordbook, currentScope, isShared, langFilter, otherLangWords, addToWordbook as addEntry, scopedWordbook, setKnown, ignoreWords, } from '../wordbook.js';
import { getSettings, getLang } from '../runtime.js';
import { currentChatId } from '../storage.js';
import { toggleReanalysis } from './reanalysis-bar.js';
import { redrawRunProgress } from './run-progress.js';
import { startSoundRun } from './sound-bar.js';
import { soundsOffered } from '../sound-maker.js';
import { lacksSound } from '../word-sounds.js';
import { emptyFilter } from './wordbook/filters.js';
import { isMissed, isCard, wordStatus } from '../srs.js';
import { renderList, countLabel, selectedWords } from './wordbook/list.js';
import { pickAndImport } from './wordbook/import.js';
import { showDuplicates } from './wordbook/duplicates.js';
export { renderDetail } from './wordbook/detail.js';
const SEARCH_DEBOUNCE_MS = 150;
/** Persists while the panel stays open (search is reset when the tab is re-mounted). */
const filter = emptyFilter();
const LEVEL_PILLS = [...LEVEL_FILTERS, 'sentence'];
const STATUSES = ['new', 'learning', 'known'];
/** Words (not grammar or sentences) in each status. */
function statusCounts() {
    const counts = { new: 0, learning: 0, known: 0 };
    for (const w of scopedWordbook())
        if (isCard(w))
            counts[wordStatus(w)]++;
    return counts;
}
function toolbarCounts() {
    const words = scopedWordbook();
    return {
        missed: words.filter(isMissed).length,
        status: statusCounts(),
        noSound: soundsOffered() ? words.filter(lacksSound).length : null,
    };
}
let pane = null;
// ── Markup ────────────────────────────────────────────────────────────────────
const toolbar = (sets, { missed, status, noSound }) => html `
    <div class="pg-run-bar pg-wb-reanalysis-bar" hidden></div>
    <div class="pg-run-bar pg-wb-sound-bar" hidden></div>

    <div class="pg-wb-search-row">
        <input type="search" class="pg-wb-search-inp" placeholder="${t('wb.searchPh')}" value="${filter.query}" aria-label="${t('wb.searchPh')}">
        ${filter.query && html `<button class="pg-wb-search-clear" data-action="clear-search" title="${t('wb.clearSearch')}">✕</button>`}
    </div>

    <div class="pg-wb-filters">
        <div class="pg-filter-pills">${LEVEL_PILLS.map(level => html `
            <button class="pg-filter-pill ${filter.level === level && 'active'}" data-action="level" data-level="${level}">
                ${level === 'all' ? t('wb.filterAll') : levelLabel(level)}
            </button>`)}
            ${(missed > 0 || filter.missed) && html `
            <button class="pg-filter-pill pg-filter-missed ${filter.missed && 'active'}" data-action="missed" title="${t('wb.missedTip')}">
                ${t('wb.missed', { n: missed })}
            </button>`}
            ${((noSound ?? 0) > 0 || filter.noSound) && html `
            <button class="pg-filter-pill ${filter.noSound && 'active'}" data-action="no-sound" title="${t('snd.noSoundTip')}">
                ${t('snd.noSound', { n: noSound ?? 0 })}
            </button>`}
        </div>
        <div class="pg-wb-set-row">
            <select class="pg-set-select pg-status-select" aria-label="${t('wb.allStatus')}">
                <option value="all">${t('wb.allStatus')}</option>
                ${STATUSES.map(st => html `<option value="${st}" ${filter.status === st && html `selected`}>${t(`wb.status.${st}`)} ${status[st]}</option>`)}
            </select>
            <select class="pg-set-select" aria-label="${t('wb.allSets')}">
                <option value="all">${t('wb.allSets')}</option>
                ${sets.map(s => html `<option value="${s.id}" ${filter.setId === s.id && html `selected`}>${s.name}</option>`)}
            </select>
            <button class="pg-icon-btn" data-action="new-set" title="${t('wb.newSetTitle')}"><i class="fa-solid fa-plus"></i></button>
        </div>
    </div>

    <div class="pg-wb-count-row">
        <span class="pg-wb-count"></span>
        <span class="pg-wb-sel-count" hidden></span>
        <button class="pg-wb-row-btn pg-wb-row-btn-danger pg-wb-when-selected" data-action="delete-selected" hidden>${t('wb.delete')}</button>
        <button class="pg-wb-row-btn pg-wb-when-selected" data-action="reanalyse-selected" hidden>${t('wb.reanalyse')}</button>
        <button class="pg-wb-row-btn pg-wb-when-selected" data-action="known-selected" title="${t('wb.markKnown')}" hidden>${t('wb.toKnown')}</button>
        <button class="pg-wb-row-btn pg-wb-when-selected" data-action="ignore-selected" title="${t('wb.ignoreTip')}" hidden>${t('wb.ignore')}</button>
        ${noSound !== null && html `
        <button class="pg-wb-row-btn pg-wb-when-selected" data-action="sounds-selected" title="${t('snd.makeTip')}" hidden>${t('snd.make')}</button>`}
        <span class="pg-wb-count-spacer"></span>
        <button class="pg-wb-row-btn" data-action="dupes" title="${t('wb.dupFindTip')}">${t('wb.dupFind')}</button>
        <button class="pg-wb-row-btn" data-action="select-all">${t('wb.selectAll')}</button>
    </div>
    <div class="pg-wb-dupes" hidden></div>

    <div class="pg-wb-list"></div>

    ${sets.length > 0 && html `
    <div class="pg-set-manager">
        <div class="pg-set-manager-title">${t('wb.manageSets')}</div>
        ${sets.map(s => html `
        <div class="pg-set-row">
            <span class="pg-set-name">${s.name}</span>
            <button class="pg-icon-btn pg-set-del" data-action="delete-set" data-id="${s.id}" title="${t('wb.deleteSet')}">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>`)}
    </div>`}`;
// ── Parts ─────────────────────────────────────────────────────────────────────
const listOf = (root) => root.querySelector('.pg-wb-list');
/** Shows the selection count and the selection-only buttons when rows are ticked. */
function updateSelection(root) {
    const list = listOf(root);
    if (!list)
        return;
    const n = selectedWords(list).length;
    const total = list.querySelectorAll('.pg-wb-row-chk').length;
    const count = root.querySelector('.pg-wb-count');
    const sel = root.querySelector('.pg-wb-sel-count');
    if (count)
        count.hidden = n > 0;
    if (sel) {
        sel.hidden = n === 0;
        sel.textContent = t('wb.nSelected', { n, total });
    }
    root.querySelectorAll('.pg-wb-when-selected').forEach(b => { b.hidden = n === 0; });
    const all = root.querySelector('[data-action="select-all"]');
    if (all)
        all.textContent = total > 0 && n === total ? t('wb.deselectAll') : t('wb.selectAll');
}
/** Re-renders only the list (keeps the search box focused while typing). */
function renderListOnly(root) {
    const list = listOf(root);
    if (!list)
        return;
    const ctx = {
        filter,
        sets: getSets(),
        refresh: () => renderWordbook(root),
        onSelect: () => updateSelection(root),
    };
    const counts = renderList(list, ctx);
    const count = root.querySelector('.pg-wb-count');
    // Say what the settings limit the list to: the study language (when other
    // languages have words) and the open chat
    const limits = [
        langFilter() && otherLangWords() ? getLang() : '',
        currentChatId() && isShared() && currentScope() === 'chat' ? t('wb.scopeChat') : '',
    ].filter(Boolean);
    if (count instanceof HTMLElement)
        count.title = count.textContent = [countLabel(counts, filter), ...limits].join(' · ');
    updateSelection(root);
}
const ACTIONS = {
    'clear-search': root => { filter.query = ''; renderWordbook(root); },
    'dupes': root => {
        const el = root.querySelector('.pg-wb-dupes');
        if (el)
            showDuplicates(el, () => renderListOnly(root));
    },
    'missed': root => { filter.missed = !filter.missed; renderWordbook(root); },
    'no-sound': root => { filter.noSound = !filter.noSound; renderWordbook(root); },
    'level': (root, el) => {
        filter.level = el.dataset.level ?? 'all';
        filter.pos = ''; // a POS filter on top of a level pill is confusing
        renderWordbook(root);
    },
    'new-set': async (root) => {
        const name = (await askInput(t('wb.newSet'), { hint: t('wb.newSetHint') }))?.trim();
        if (name) {
            createSet(name);
            renderWordbook(root);
        }
    },
    'select-all': root => {
        const boxes = [...root.querySelectorAll('.pg-wb-row-chk')];
        const all = boxes.every(b => b.checked);
        boxes.forEach(b => { b.checked = !all; });
        updateSelection(root);
    },
    'delete-selected': async (root) => {
        const list = listOf(root);
        const words = list ? selectedWords(list) : [];
        if (!words.length)
            return;
        if (!(await askConfirm(t('wb.delConfirm', { n: words.length }), { yes: t('wb.delSetBtn') })))
            return;
        removeFromWordbook(words);
        renderWordbook(root);
    },
    'known-selected': root => {
        const list = listOf(root);
        const words = list ? selectedWords(list) : [];
        if (!words.length)
            return;
        setKnown(words, true);
        renderWordbook(root);
    },
    'ignore-selected': async (root) => {
        const list = listOf(root);
        // Words only: a grammar pattern or a sentence is not something the analysis highlights as a word
        const cards = new Set(scopedWordbook().filter(isCard).map(w => w.word));
        const words = (list ? selectedWords(list) : []).filter(w => cards.has(w));
        if (!words.length) {
            notify(t('wb.ignoreNone'), 'info');
            return;
        }
        if (!(await askConfirm(t('wb.ignoreConfirm', { n: words.length }), { yes: t('wb.ignore') })))
            return;
        ignoreWords(words);
        renderWordbook(root);
    },
    'reanalyse-selected': root => {
        const list = listOf(root);
        const words = list ? selectedWords(list) : [];
        // Looked up at each update in the tab shown now: it is redrawn, or rebuilt when the panel reopens
        const bar = () => pane?.querySelector('.pg-wb-reanalysis-bar') ?? null;
        if (words.length)
            toggleReanalysis({ bar, words, confirm: true, onDone: () => { if (pane)
                    renderListOnly(pane); } });
    },
    'sounds-selected': root => {
        const list = listOf(root);
        const words = list ? selectedWords(list) : [];
        const bar = () => pane?.querySelector('.pg-wb-sound-bar') ?? null;
        if (words.length)
            void startSoundRun({ bar, words, onDone: refreshWordbook });
    },
    'delete-set': async (root, el) => {
        const id = el.dataset.id ?? '';
        const name = getSets().find(s => s.id === id)?.name ?? '';
        if (!(await askConfirm(t('wb.delSet', { name }), { yes: t('wb.delSetBtn') })))
            return;
        deleteSet(id);
        if (filter.setId === id)
            filter.setId = 'all';
        renderWordbook(root);
    },
};
function bind(root) {
    root.addEventListener('click', e => {
        const el = e.target.closest('[data-action]');
        // Row actions are handled by the list itself
        if (!el || el.closest('.pg-wb-list'))
            return;
        ACTIONS[el.dataset.action ?? '']?.(root, el);
    });
    // Typing re-filters after a short pause instead of on every keystroke
    let typing;
    root.addEventListener('input', e => {
        const input = e.target;
        if (!input.classList.contains('pg-wb-search-inp'))
            return;
        filter.query = input.value;
        clearTimeout(typing);
        typing = setTimeout(() => renderListOnly(root), SEARCH_DEBOUNCE_MS);
    });
    root.addEventListener('change', e => {
        const select = e.target;
        // The inline edit form's selects (level, part of speech) live in the list
        if (select.closest('.pg-wb-list'))
            return;
        if (select.classList.contains('pg-status-select')) {
            filter.status = select.value;
            renderWordbook(root);
            return;
        }
        if (!select.classList.contains('pg-set-select'))
            return;
        filter.setId = select.value;
        renderWordbook(root);
    });
}
// ── Public API ────────────────────────────────────────────────────────────────
const bound = new WeakSet();
export function renderWordbook(root) {
    // A fresh mount starts with an empty search; re-renders keep it
    if (!listOf(root))
        filter.query = '';
    const scroll = listOf(root)?.scrollTop ?? 0;
    pane = root;
    setHtml(root, toolbar(getSets(), toolbarCounts()));
    // A run under way shows its progress and Stop in the redrawn toolbar at once
    redrawRunProgress();
    if (!bound.has(root)) {
        bind(root);
        bound.add(root);
    }
    renderListOnly(root);
    const list = listOf(root);
    if (list)
        list.scrollTop = scroll;
}
/** Re-renders the wordbook tab if the panel has one. */
export function refreshWordbook() {
    if (pane)
        renderWordbook(pane);
}
/** Forgets the tab element (the panel was closed). */
export function unmountWordbook() {
    pane = null;
}
/** Opens a file picker: CSV / TXT become a new set (shown afterwards), JSON restores a backup. */
export async function triggerImport() {
    const result = await pickAndImport();
    if (!result)
        return;
    if (result.setId)
        filter.setId = result.setId;
    refreshWordbook();
}
/** Starts (or stops) re-analysis of every vocabulary entry, reporting into `bar`. */
export function reanalyseAll(bar, onBusy) {
    return toggleReanalysis({ bar, onBusy, onDone: refreshWordbook });
}
/** Adds an entry, tagging its meaning language, and refreshes the wordbook tab. */
export function addToWordbook(entry) {
    if (!entry.meaning_lang) {
        const s = getSettings();
        entry.meaning_lang = s.native_lang === 'custom'
            ? (s.native_lang_custom?.slice(0, 10) || 'custom')
            : (s.native_lang ?? 'en');
    }
    if (addEntry(entry))
        refreshWordbook();
}
