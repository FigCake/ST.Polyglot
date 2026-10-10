// ════════════════════════════
// Polyglot  ui/wordbook/detail.ts
// ════════════════════════════
// The Learn tab's detail card: a looked-up word, a grammar pattern, an idiom,
// or the loading / error / empty states.
//
// Dependencies: constants.ts, utils.ts, html.ts, i18n.ts, wordbook.ts, runtime.ts,
//               speech.ts, ui/wordbook/note-editor.ts
import { dictUrl } from '../../constants.js';
import { levelClass, levelLabel } from '../../utils.js';
import { html, setHtml, raw } from '../../html.js';
import { t } from '../../i18n.js';
import { scopedWordbook } from '../../wordbook.js';
import { getSettings, getLang } from '../../runtime.js';
import { speak } from '../../speech.js';
import { toggleNoteEditor } from './note-editor.js';
import { rubyWord, shownReading } from '../../furigana/word.js';
import { userFileUrl } from '../../user-files.js';
/** Saved in the current scope (saving again adds an existing word to this chat). */
const isSaved = (...words) => scopedWordbook().some(e => words.includes(e.word));
/** Multi-line i18n text with line breaks kept. */
const lines = (text) => html `${text.split('\n').map((line, i) => html `${i > 0 && raw('<br>')}${line}`)}`;
const header = (title, badge, extra) => html `
    <div class="pg-word-detail-header"><h2>${title}</h2>${extra}${badge}</div>`;
/** A labelled row; omitted when empty unless `always`. */
const section = (label, value, always = false) => (value || always) && html `
    <div class="pg-grammar-section"><span class="pg-g-label">${label}</span>${value ?? ''}</div>`;
function saveButton(saved, label) {
    return html `
        <button class="pg-btn pg-btn-primary pg-btn-full pg-detail-save" ${saved && html `disabled`}>
            ${saved ? t('det.saved') : label}
        </button>`;
}
/** Wires the save button: saves once, then shows "Saved". */
function bindSave(container, entry, actions) {
    const btn = container.querySelector('.pg-detail-save');
    btn?.addEventListener('click', () => {
        actions.save(entry);
        btn.textContent = t('det.saved');
        btn.disabled = true;
    }, { once: true });
}
// ── Views ─────────────────────────────────────────────────────────────────────
const loadingView = html `
    <div class="pg-detail-skeleton">
        <div class="pg-skeleton pg-detail-skeleton-title"></div>
        <div class="pg-skeleton"></div><div class="pg-skeleton"></div>
        <div class="pg-skeleton"></div><div class="pg-skeleton"></div>
        <div class="pg-skeleton pg-detail-skeleton-button"></div>
    </div>`;
function renderError(container, word, message, actions) {
    setHtml(container, html `
        ${header(word, raw(''))}
        <div class="pg-error-msg">${t('det.failed')} ${message}</div>
        <button class="pg-btn pg-btn-secondary pg-btn-full pg-detail-retry">${t('det.retry')}</button>`);
    container.querySelector('.pg-detail-retry')?.addEventListener('click', () => actions.lookup(word));
}
function notesBlock(notes) {
    return html `
        <div class="pg-det-notes-wrap">
            <div class="pg-det-notes-header">
                <span class="pg-det-notes-label">${t('wb.noteLabel')}</span>
                <button class="pg-icon-btn pg-det-note-edit" title="${t('wb.noteTitle')}">📝</button>
            </div>
            <div class="${notes ? 'pg-det-notes-text' : 'pg-det-notes-empty'}">${notes || t('wb.noteEmpty')}</div>
            <div class="pg-wb-note-editor" hidden></div>
        </div>`;
}
function renderWord(container, w, actions) {
    const canonical = w.base_form?.trim() || w.word;
    const entry = scopedWordbook().find(e => e.word === canonical || e.word === w.word);
    const s = getSettings();
    const dict = dictUrl(s.language, w.word, s.dict_url_custom);
    const reading = shownReading(w) ?? (entry && shownReading(entry));
    // The reading belongs to the base form, but models sometimes give the surface form's:
    // each shows ruby only where it fits
    setHtml(container, html `
        ${header(rubyWord(w.word, reading), html `<span class="pg-level-badge level-${levelClass(w.level)}">${levelLabel(w.level)}</span>`, html `
            ${dict && html `<a href="${dict}" target="_blank" rel="noopener" class="pg-icon-btn pg-dict-btn" title="${t('tap.lookUp')}">📖</a>`}
            <button class="pg-speak-btn" title="${t('wb.listen')}" aria-label="${t('wb.listen')}">🔊</button>`)}
        <div class="pg-word-meta">
            <span class="pg-meta-base">${w.base_form ? rubyWord(w.base_form, reading) : ''}</span>
            <span class="pg-meta-pos">${w.pos_info ?? ''}</span>
        </div>
        <div class="pg-word-meaning">${w.meaning}</div>
        ${entry?.image && html `<img class="pg-word-img" src="${userFileUrl(entry.image)}" alt="">`}
        ${(w.word_family?.length ?? 0) > 0 && html `
        <div class="pg-det-family">
            <span class="pg-det-family-label">${t('det.wordFamily')}</span>
            <div class="pg-det-family-chips">${w.word_family?.map(f => html `
                <button class="pg-det-family-chip" data-word="${f.form}" title="${f.meaning}">
                    <span class="pg-det-family-form">${f.form}</span>
                    <span class="pg-det-family-pos">${f.pos}</span>
                </button>`)}
            </div>
        </div>`}
        ${entry && notesBlock(entry.notes)}
        ${saveButton(!!entry, t('det.addWord'))}`);
    container.querySelector('.pg-speak-btn')?.addEventListener('click', () => speak(canonical, getLang(), entry?.audio));
    container.querySelector('.pg-det-family-chips')?.addEventListener('click', e => {
        const form = e.target.closest('[data-word]')?.dataset.word;
        if (form)
            actions.lookup(form);
    });
    container.querySelector('.pg-det-note-edit')?.addEventListener('click', () => toggleNoteEditor({
        editor: container.querySelector('.pg-det-notes-wrap .pg-wb-note-editor'),
        preview: container.querySelector('.pg-det-notes-wrap > :is(.pg-det-notes-text, .pg-det-notes-empty)'),
        onSaved: () => renderWord(container, w, actions),
    }, canonical));
    if (!entry)
        bindSave(container, w, actions);
}
function renderGrammar(container, g, actions) {
    const saved = isSaved(g.pattern);
    setHtml(container, html `
        ${header(g.pattern, html `<span class="pg-level-badge level-grammar">${t('det.gram')}</span>`)}
        ${section(t('det.meaning'), g.meaning, true)}
        ${section(t('det.structure'), g.structure, true)}
        ${section(t('det.words'), g.words_used, true)}
        ${saveButton(saved, t('det.addGram'))}`);
    if (!saved)
        bindSave(container, {
            word: g.pattern, base_form: g.words_used || '', pos_info: g.structure || '', meaning: g.meaning || '', level: 'grammar',
        }, actions);
}
function renderIdiom(container, idiom, actions) {
    const base = idiom.base_form || idiom.phrase;
    const saved = isSaved(base);
    setHtml(container, html `
        ${header(idiom.phrase, html `<span class="pg-level-badge level-idiom">${t('det.idiom')}</span>`)}
        ${base !== idiom.phrase && section(t('det.baseForm'), base)}
        ${section(t('det.meaning'), idiom.meaning, true)}
        ${section(t('det.context'), idiom.context_meaning)}
        ${saveButton(saved, t('det.addToWb'))}`);
    if (!saved)
        bindSave(container, {
            word: idiom.phrase, base_form: base, meaning: idiom.meaning, level: 'idiom', context_meaning: idiom.context_meaning,
        }, actions);
}
// ── Public API ────────────────────────────────────────────────────────────────
export function renderDetail(container, data, actions) {
    if (!data) {
        setHtml(container, html `<div class="pg-empty-hint">${lines(t('det.hint'))}</div>`);
        return;
    }
    switch (data.type) {
        case 'loading':
            setHtml(container, loadingView);
            break;
        case 'error':
            renderError(container, data.word, data.message, actions);
            break;
        case 'word':
            renderWord(container, data.data, actions);
            break;
        case 'grammar':
            renderGrammar(container, data.data, actions);
            break;
        case 'idiom':
            renderIdiom(container, data.data, actions);
            break;
    }
}
