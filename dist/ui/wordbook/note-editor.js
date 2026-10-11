// Inline note editor for a wordbook entry (list row or detail card).
// Saves on the Save button, Ctrl/⌘+Enter or blur; Escape cancels.
import { html, setHtml } from '../../html.js';
import { t } from '../../i18n.js';
import { loadWordbook, saveWordbook } from '../../wordbook.js';
/** Saving after blur waits this long so a click on Save / Cancel lands first. */
const BLUR_SAVE_DELAY = 150;
export function isNoteEditorOpen(editor) {
    return !editor.hidden;
}
export function closeNoteEditor({ editor, preview }) {
    editor.hidden = true;
    editor.replaceChildren();
    if (preview)
        preview.hidden = !preview.textContent;
}
export function openNoteEditor(parts, word) {
    const { editor, preview, button } = parts;
    const current = loadWordbook().find(e => e.word === word)?.notes ?? '';
    if (preview)
        preview.hidden = true;
    editor.hidden = false;
    setHtml(editor, html `
        <textarea class="pg-wb-note-textarea" placeholder="${t('wb.notePh')}" rows="3">${current}</textarea>
        <div class="pg-wb-note-actions">
            <span class="pg-wb-note-hint">${t('wb.noteHint')}</span>
            <button class="pg-wb-note-cancel pg-wb-row-btn">${t('wb.noteCancel')}</button>
            <button class="pg-wb-note-save pg-wb-row-btn pg-wb-note-save-btn">${t('wb.noteSave')}</button>
        </div>`);
    const textarea = editor.querySelector('textarea');
    if (!textarea)
        return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    let done = false;
    const save = () => {
        if (done)
            return;
        done = true;
        const text = textarea.value.trim();
        const wordbook = loadWordbook();
        const entry = wordbook.find(e => e.word === word);
        if (entry) {
            entry.notes = text || undefined;
            saveWordbook(wordbook);
        }
        if (preview)
            preview.textContent = text;
        button?.classList.toggle('pg-wb-note-btn-has', !!text);
        closeNoteEditor(parts);
        parts.onSaved?.(text);
    };
    const cancel = () => {
        if (done)
            return;
        done = true;
        closeNoteEditor(parts);
    };
    editor.querySelector('.pg-wb-note-save')?.addEventListener('click', e => { e.stopPropagation(); save(); });
    editor.querySelector('.pg-wb-note-cancel')?.addEventListener('click', e => { e.stopPropagation(); cancel(); });
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
    textarea.addEventListener('blur', () => setTimeout(save, BLUR_SAVE_DELAY));
}
/** Opens the editor, or closes it when it is already open. */
export function toggleNoteEditor(parts, word) {
    if (isNoteEditorOpen(parts.editor))
        closeNoteEditor(parts);
    else
        openNoteEditor(parts, word);
}
