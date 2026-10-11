// Panel settings tab: wordbook data tools, study options, appearance.
//
// Design rules:
//   • Markup is declarative; behaviour is attached by delegation:
//       data-action="…"   → ACTIONS[action](root, button)
//       data-setting="…"  → written straight to settings on input/change,
//                           then SETTING_EFFECTS[setting] runs (if any)
//   • Adding a button or option is one markup line plus one table entry.
import { getSettings, updateSettings, getLang } from '../../runtime.js';
import { html, setHtml } from '../../html.js';
import { askConfirm, notify } from '../../ui.manager.js';
import { t } from '../../i18n.js';
import { loadWordbook, saveWordbook, scopedWordbook, isShared, currentScope, wordsWithoutLang, adoptWordsWithoutLang, clearAllConjCache, exportToCSV, exportToFlashcardTxt, } from '../../wordbook.js';
import { exportToPDF } from '../../export/pdf.js';
import { getAllConjEntries } from '../../conj-cache.js';
import { clearCurrentChatAnnotations } from '../../annotator.js';
import { triggerImport, reanalyseAll, refreshWordbook } from '../wordbook-ui.js';
import { saveBackup } from '../backup-ui.js';
import { applyPanelTheme, findPanelEl, setFloating } from './chrome.js';
import { mountChatsSection } from './chats-section.js';
import { showLicenses } from '../licenses.js';
import { storeMode } from '../../data-store.js';
import { furiganaEnabled, applyFuriganaDisplay, warnIfFontClamped } from '../../furigana/messages.js';
// ── Markup ────────────────────────────────────────────────────────────────────
// Labels are i18n keys (resolved at render time, so a language switch applies on reopen)
const EXPORT_BUTTONS = [
    { action: 'import', icon: 'fa-file-import', title: 'pnl.set.import' },
    { action: 'csv', icon: 'fa-file-csv', title: 'pnl.set.export' },
    { action: 'txt', icon: 'fa-file-lines', title: 'pnl.set.exportTxt' },
    { action: 'pdf', icon: 'fa-file-pdf', title: 'pnl.set.exportPdf' },
    { action: 'backup', icon: 'fa-box-archive', title: 'pnl.set.backup' },
];
const STORE_LABELS = {
    file: 'data.whereFile',
    offline: 'data.whereOffline',
    loading: 'data.whereLoading',
    chat: 'data.whereChat',
};
const FURIGANA_DISPLAY = [
    { value: 'show', label: 'furi.show' },
    { value: 'hover', label: 'furi.hover' },
];
const FURIGANA_SIZES = [
    { value: '0.5', label: 'furi.small' },
    { value: '0.65', label: 'furi.medium' },
    { value: '0.8', label: 'furi.large' },
];
const THEMES = [
    { value: 'dark', label: 'set.themeDark' },
    { value: 'light', label: 'set.themeLight' },
    { value: 'breeze', label: 'set.themeBreeze' },
    { value: 'milk', label: 'set.themeMilk' },
];
const section = (title, body) => html `
    <section class="pg-pset-section">
        <h3 class="pg-pset-section-title">${title}</h3>
        ${body}
    </section>`;
const toggleRow = (setting, label, checked) => html `
    <label class="pg-pset-row">
        <span class="pg-pset-label">${label}</span>
        <input type="checkbox" class="pg-pset-check" data-setting="${setting}" ${checked && html `checked`}>
    </label>`;
const selectRow = (setting, label, value, options) => html `
    <label class="pg-pset-row">
        <span class="pg-pset-label">${label}</span>
        <select class="text_pole pg-pset-select" data-setting="${setting}">${options.map(o => html `
            <option value="${o.value}" ${o.value === value && html `selected`}>${t(o.label)}</option>`)}
        </select>
    </label>`;
const textField = (setting, label, value, placeholder, hint) => html `
    <label class="pg-pset-field">
        <span class="pg-pset-label">${label}</span>
        <input type="text" class="text_pole" data-setting="${setting}" value="${value}"
               placeholder="${placeholder}" autocomplete="off" spellcheck="false">
        ${hint && html `<span class="pg-pset-hint">${hint}</span>`}
    </label>`;
const dangerButton = (action, label) => html `
    <button class="pg-btn pg-btn-secondary pg-btn-block pg-btn-danger" data-action="${action}">${label}</button>`;
function render(s) {
    const theme = s.panel_theme ?? 'dark';
    return html `
    <div class="pg-pset">
        ${section(t('tab.wordbook'), html `
            <div class="pg-pset-icon-row">${EXPORT_BUTTONS.map(b => html `
                <button class="pg-pset-icon-btn" data-action="${b.action}" title="${t(b.title)}" aria-label="${t(b.title)}">
                    <i class="fa-solid ${b.icon}"></i>
                </button>`)}
            </div>
            <button class="pg-btn pg-btn-secondary pg-btn-block" data-action="reanalyse" title="${t('wb.reanalyseTip')}">
                ✨ ${t('wb.reanalyse')}
            </button>
            <div class="pg-reanalysis-bar" hidden></div>
            ${isShared() && html `
            <label class="pg-pset-row">
                <span class="pg-pset-label">${t('pnl.set.chatOnly')}</span>
                <input type="checkbox" class="pg-pset-check pg-scope-check" ${currentScope() === 'chat' && html `checked`}>
            </label>`}
            ${toggleRow('wordbook_lang_only', t('pnl.set.langOnly', { lang: getLang() }), s.wordbook_lang_only !== false)}
            ${wordsWithoutLang() > 0 && html `
            <button class="pg-btn pg-btn-secondary pg-btn-block" data-action="adopt-lang">
                ${t('pnl.set.adoptLang', { n: wordsWithoutLang(), lang: getLang() })}
            </button>`}
            ${isShared() && html `<div class="pg-pset-chats"></div>`}
            <div class="pg-pset-hint pg-pset-store">${t('data.where')}: ${t(STORE_LABELS[storeMode()])}</div>`)}

        ${section(t('tab.learn'), html `
            ${toggleRow('auto_save_idioms', t('pnl.set.autoIdioms'), s.auto_save_idioms !== false)}
            ${dangerButton('reset-srs', t('pnl.set.resetSrs'))}
            ${dangerButton('clear-conj', t('pnl.set.clearConj'))}
            ${dangerButton('clear-chat', t('pnl.set.clearChat'))}
            ${textField('dict_url_custom', t('pnl.set.dictUrl'), s.dict_url_custom ?? '', t('pnl.set.dictUrlPh'), t('pnl.set.dictUrlDesc'))}`)}

        ${furiganaEnabled() && section(t('furi.section'), html `
            ${selectRow('furigana_display', t('furi.display'), s.furigana_display ?? 'show', FURIGANA_DISPLAY)}
            ${selectRow('furigana_size', t('furi.size'), String(s.furigana_size ?? 0.65), FURIGANA_SIZES)}
            ${toggleRow('furigana_auto', t('furi.auto'), !!s.furigana_auto)}
            <span class="pg-pset-hint">${t('furi.autoHint')}</span>`)}

        ${section(t('set.panelSection'), html `
            <label class="pg-pset-row">
                <span class="pg-pset-label">${t('pnl.set.theme')}</span>
                <select class="text_pole pg-pset-select" data-setting="panel_theme">${THEMES.map(o => html `
                    <option value="${o.value}" ${o.value === theme && html `selected`}>${t(o.label)}</option>`)}
                </select>
            </label>
            ${toggleRow('panel_floating', t('pnl.set.floating'), !!s.panel_floating)}
            ${textField('panel_bg_image', t('pnl.set.bgUrl'), s.panel_bg_image ?? '', t('pnl.set.bgUrlPh'))}`)}

        <footer class="pg-pset-footer">
            <button class="pg-link-btn" data-action="licenses">${t('lic.link')}</button>
        </footer>
    </div>`;
}
// ── Actions ───────────────────────────────────────────────────────────────────
/** Runs `fn` after the user confirms, then shows "<label> ✓". */
async function confirmed(question, doneLabel, fn) {
    if (!(await askConfirm(question)))
        return;
    await fn();
    notify(`${doneLabel} ✓`);
}
/** Disables a button and shows a spinner while `fn` runs. */
async function withBusy(btn, fn) {
    const idle = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
        await fn();
    }
    finally {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.innerHTML = idle;
    }
}
/** Resets review progress of the words in the current scope. */
function resetSrs() {
    const inView = new Set(scopedWordbook().map(w => w.word));
    const wordbook = loadWordbook();
    for (const w of wordbook) {
        if (!inView.has(w.word))
            continue;
        Object.assign(w, { srs_interval: 1, srs_ease: 2.5, srs_due: 0, srs_streak: 0, srs_reviewed_at: undefined });
    }
    saveWordbook(wordbook);
}
async function exportPdf(btn) {
    const wordbook = scopedWordbook();
    if (!wordbook.length) {
        notify(t('wb.noExport'), 'warn');
        return;
    }
    await withBusy(btn, async () => exportToPDF(wordbook, await getAllConjEntries(getLang())));
}
function reanalyse(root, btn) {
    const bar = root.querySelector('.pg-reanalysis-bar');
    if (!bar)
        return;
    reanalyseAll(bar, busy => { btn.textContent = busy ? t('wb.reanalysing') : `✨ ${t('wb.reanalyse')}`; });
}
const ACTIONS = {
    'import': () => triggerImport(),
    'csv': () => exportToCSV(scopedWordbook()),
    'txt': () => exportToFlashcardTxt(scopedWordbook()),
    'backup': (_, btn) => withBusy(btn, async () => { await saveBackup(); }),
    'pdf': (_, btn) => exportPdf(btn),
    'reanalyse': reanalyse,
    'licenses': () => showLicenses(),
    'reset-srs': () => confirmed(t('pnl.set.resetSrsConfirm'), t('pnl.set.resetSrs'), resetSrs),
    'clear-conj': () => confirmed(t('pnl.set.clearConjConfirm'), t('pnl.set.clearConj'), clearAllConjCache),
    'clear-chat': () => confirmed(t('pnl.set.clearChatConfirm'), t('pnl.set.clearChat'), clearCurrentChatAnnotations),
    'adopt-lang': async (_root, btn) => {
        const n = wordsWithoutLang();
        if (!await askConfirm(t('pnl.set.adoptLangConfirm', { n, lang: getLang() }), { yes: t('pnl.set.adoptLangYes'), no: t('wb.editCancel') }))
            return;
        notify(t('pnl.set.adoptLangDone', { n: adoptWordsWithoutLang(), lang: getLang() }), 'info', 3000);
        btn.remove();
        refreshWordbook();
    },
};
/** Side effects that must follow a settings change for it to be visible immediately. */
const SETTING_EFFECTS = {
    panel_theme: applyPanelTheme,
    furigana_display: applyFuriganaDisplay,
    furigana_size: () => { applyFuriganaDisplay(); warnIfFontClamped(); },
    panel_bg_image: applyPanelTheme,
    panel_floating: on => { const panel = findPanelEl(); if (panel)
        setFloating(panel, !!on); },
    wordbook_lang_only: () => refreshWordbook(),
};
function readInput(el) {
    if (el instanceof HTMLInputElement && el.type === 'checkbox')
        return el.checked;
    if (el.dataset.setting === 'furigana_size')
        return Number(el.value);
    return el.dataset.setting === 'panel_bg_image' ? el.value.trim() : el.value;
}
// ── Public ────────────────────────────────────────────────────────────────────
export function buildSettingsTab() {
    const root = document.createElement('div');
    root.className = 'pg-box-pane';
    setHtml(root, render(getSettings()));
    const chats = root.querySelector('.pg-pset-chats');
    if (chats)
        mountChatsSection(chats);
    root.addEventListener('click', e => {
        const btn = e.target.closest('button[data-action]');
        if (btn)
            ACTIONS[btn.dataset.action ?? '']?.(root, btn);
    });
    const onSettingChange = (e) => {
        const input = e.target.closest('[data-setting]');
        const key = input?.dataset.setting;
        if (!input || !key)
            return;
        const value = readInput(input);
        updateSettings({ [key]: value });
        SETTING_EFFECTS[key]?.(value);
    };
    // Text fields save as you type; checkboxes and selects fire `change`
    root.addEventListener('input', e => { if (e.target.type === 'text')
        onSettingChange(e); });
    root.addEventListener('change', e => { if (e.target.type !== 'text')
        onSettingChange(e); });
    // On (the default): the wordbook, study modes and exports use the open chat's words; off: all chats'
    root.querySelector('.pg-scope-check')?.addEventListener('change', e => {
        updateSettings({ wordbook_scope: e.target.checked ? 'chat' : 'all' });
        refreshWordbook();
    });
    return root;
}
