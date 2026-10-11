// Edit every field of a wordbook row in place: word, base form, meanings,
// level, part of speech, reading (Japanese) or pronunciation.
//
// Renaming onto a word that already exists merges the two entries.
import { CEFR_LEVELS, POS_TAGS } from '../../constants.js';
import { isJapanese, levelLabel } from '../../utils.js';
import { html, setHtml } from '../../html.js';
import { t } from '../../i18n.js';
import { notify } from '../../ui.manager.js';
import { getLang } from '../../runtime.js';
import { loadWordbook, editWord } from '../../wordbook.js';
const LEVELS = [...CEFR_LEVELS, 'idiom', 'grammar', 'sentence'];
/** Replaces the row's content with the form. `done` re-renders the list (saved or cancelled). */
export function openEditForm(item, word, done) {
    const e = loadWordbook().find(w => w.word === word);
    if (!e)
        return;
    const japanese = isJapanese(getLang());
    const field = (name, label, value, wide = false) => html `
        <label class="pg-wb-edit-field ${wide && 'pg-wb-edit-wide'}">
            <span>${label}</span>
            <input type="text" class="pg-soft-input" name="${name}" value="${value ?? ''}" autocomplete="off" spellcheck="false">
        </label>`;
    item.classList.add('pg-wb-editing');
    setHtml(item, html `
        <form class="pg-wb-edit">
            ${field('word', t('wb.fWord'), e.word)}
            ${field('base_form', t('wb.fBase'), e.base_form)}
            ${field('meaning', t('wb.fMeaning'), e.meaning, true)}
            ${field('context_meaning', t('wb.fContext'), e.context_meaning, true)}
            ${japanese ? field('reading', t('wb.fReading'), e.reading ?? e.ipa) : field('ipa', t('wb.fIpa'), e.ipa)}
            <label class="pg-wb-edit-field">
                <span>${t('wb.fLevel')}</span>
                <select class="pg-set-select" name="level">
                    <option value="" ${!e.level && html `selected`}>—</option>
                    ${LEVELS.map(l => html `<option value="${l}" ${e.level === l && html `selected`}>${levelLabel(l)}</option>`)}
                </select>
            </label>
            <label class="pg-wb-edit-field">
                <span>${t('wb.fPos')}</span>
                <select class="pg-set-select" name="pos">
                    <option value="" ${!e.pos && html `selected`}>—</option>
                    ${POS_TAGS.map(p => html `<option value="${p}" ${e.pos === p && html `selected`}>${p}</option>`)}
                </select>
            </label>
            <div class="pg-wb-edit-actions">
                <button type="button" class="pg-wb-row-btn" data-edit="cancel">${t('wb.editCancel')}</button>
                <button type="submit" class="pg-btn pg-btn-primary pg-btn-compact">${t('wb.editSave')}</button>
            </div>
        </form>`);
    const form = item.querySelector('form');
    if (!form)
        return;
    form.querySelector('input[name="meaning"]')?.focus();
    form.querySelector('[data-edit="cancel"]')?.addEventListener('click', done);
    form.addEventListener('keydown', ev => { if (ev.key === 'Escape') {
        ev.stopPropagation();
        done();
    } });
    form.addEventListener('submit', ev => {
        ev.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        if (!data.word?.trim()) {
            notify(t('wb.editNeedWord'), 'warn');
            return;
        }
        const result = editWord(word, { ...data, pos: data.pos || undefined });
        if (result.merged)
            notify(t('wb.editMerged', { word: result.word }), 'info', 3000);
        done();
    });
}
