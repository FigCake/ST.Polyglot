// "Import" with an Anki package (.apkg / .colpkg):
//
//   read the package ─▶ dialog: per note type, which field is the word,
//                       the meaning, … (guessed, with a live sample)
//                     ─▶ media upload (progress, cancellable) ─▶ words added
//
// Each deck becomes a set. Sounds and images are kept only when the wordbook
// lives in the server files (they are separate files next to it).
import { html, setHtml } from '../../html.js';
import { t } from '../../i18n.js';
import { notify } from '../../ui.manager.js';
import { readAnkiPackage, AnkiFormatError } from '../../deck-import/package.js';
import { describeTypes, fieldText, notesToRows, splitFurigana, TARGETS } from '../../deck-import/fields.js';
import { addRows, canStoreMedia, mediaOf, storeMedia } from '../../deck-import/import.js';
const TARGET_LABEL = {
    word: 'anki.fWord',
    meaning: 'anki.fMeaning',
    reading: 'anki.fReading',
    example: 'anki.fExample',
    notes: 'anki.fNotes',
};
const sampleText = (note, map) => {
    const field = (target) => (note && map[target] >= 0 ? splitFurigana(fieldText(note.fields[map[target]] ?? '')).text : '');
    return t('anki.sample', { word: field('word') || '—', meaning: field('meaning') || '—' });
};
/** Reads an Anki package and runs the import dialog. Resolves with the sets filled (empty if nothing was imported). */
export async function importAnkiFile(file) {
    notify(t('anki.reading'), 'info', 2000);
    let pkg;
    try {
        pkg = await readAnkiPackage(file);
    }
    catch (e) {
        console.error('[Polyglot] Anki import:', e);
        notify(e instanceof AnkiFormatError && e.message === 'stub collection'
            ? t('anki.stub')
            : t('anki.fail', { msg: e instanceof Error ? e.message : String(e) }), 'err', 8000);
        return [];
    }
    const types = describeTypes(pkg.noteTypes, pkg.notes);
    if (!types.length) {
        notify(t('wb.importNone'), 'warn');
        return [];
    }
    return runDialog(file.name, pkg, types);
}
function runDialog(fileName, pkg, types) {
    return new Promise(resolve => {
        const media = canStoreMedia();
        const abort = new AbortController();
        let busy = false;
        const wrap = document.createElement('div');
        wrap.className = 'pg-dim';
        setHtml(wrap, html `
            <div class="pg-dialog pg-doc-dialog pg-deck-dialog" role="dialog" aria-modal="true">
                <h3 class="pg-doc-title">${t('anki.title', { file: fileName })}</h3>
                <div class="pg-doc-body">
                    ${types.map(({ type, count, sample, mapping }) => html `
                    <fieldset class="pg-anki-type" data-type="${type.id}">
                        <legend>
                            <label><input type="checkbox" data-include checked> <b>${type.name}</b>
                            <span class="pg-anki-count">${t('anki.notes', { n: count })}</span></label>
                        </legend>
                        <div class="pg-anki-map">${TARGETS.map(target => html `
                            <label>
                                <span>${t(TARGET_LABEL[target])}</span>
                                <select class="pg-set-select" data-target="${target}">
                                    <option value="-1">${t('anki.none')}</option>
                                    ${type.fields.map((f, i) => html `<option value="${i}" ${mapping[target] === i && html `selected`}>${f}</option>`)}
                                </select>
                            </label>`)}
                        </div>
                        <div class="pg-anki-sample">${sampleText(sample, mapping)}</div>
                    </fieldset>`)}
                    ${media
            ? html `<label class="pg-anki-media"><input type="checkbox" data-media checked> <span></span></label>`
            : html `<p class="pg-anki-hint">${t('anki.mediaUnavailable')}</p>`}
                    <p class="pg-anki-hint">${t('anki.hint')}</p>
                    <div class="pg-anki-progress" hidden></div>
                </div>
                <div class="pg-dialog-row">
                    <button class="pg-btn pg-btn-secondary" data-anki="cancel">${t('anki.cancel')}</button>
                    <button class="pg-btn pg-btn-primary" data-anki="import">${t('anki.import')}</button>
                </div>
            </div>`);
        const q = (sel) => wrap.querySelector(sel);
        const fieldsets = [...wrap.querySelectorAll('.pg-anki-type')];
        const mappingOf = (fs) => Object.fromEntries(TARGETS.map(target => [target, Number(fs.querySelector(`[data-target="${target}"]`)?.value ?? -1)]));
        const chosen = () => new Map(fieldsets
            .filter(fs => fs.querySelector('[data-include]')?.checked)
            .map(fs => [Number(fs.dataset.type), mappingOf(fs)]));
        const updateMediaCount = () => {
            const label = q('.pg-anki-media span');
            if (label)
                label.textContent = t('anki.media', { n: mediaOf(notesToRows(pkg.notes, chosen()), pkg.media).length });
        };
        updateMediaCount();
        wrap.addEventListener('change', e => {
            const fs = e.target.closest('.pg-anki-type');
            if (fs) {
                const desc = types.find(d => d.type.id === Number(fs.dataset.type));
                const sample = fs.querySelector('.pg-anki-sample');
                if (sample)
                    sample.textContent = sampleText(desc?.sample, mappingOf(fs));
                fs.classList.toggle('pg-anki-off', !fs.querySelector('[data-include]')?.checked);
            }
            updateMediaCount();
        });
        const finish = (sets) => {
            abort.abort();
            window.removeEventListener('keydown', onKey, true);
            wrap.remove();
            resolve(sets);
        };
        const onKey = (e) => { if (e.key === 'Escape') {
            e.stopPropagation();
            if (!busy)
                finish([]);
        } };
        window.addEventListener('keydown', onKey, true); // capture: runs before the panel's own Escape
        wrap.addEventListener('pointerdown', e => { if (e.target === wrap && !busy)
            finish([]); });
        const run = async () => {
            const mappings = chosen();
            if ([...mappings.values()].some(m => m.word < 0)) {
                notify(t('anki.noWord'), 'warn', 4000);
                return;
            }
            const rows = notesToRows(pkg.notes, mappings);
            if (!rows.length) {
                notify(t('wb.importNone'), 'warn');
                return;
            }
            busy = true;
            wrap.querySelectorAll('input, select, [data-anki="import"]').forEach(el => { el.disabled = true; });
            const progress = q('.pg-anki-progress');
            let stored = new Map();
            const names = q('[data-media]')?.checked ? mediaOf(rows, pkg.media) : [];
            if (names.length && progress) {
                progress.hidden = false;
                const result = await storeMedia(names, pkg.readMedia, p => {
                    progress.textContent = t('anki.progressMedia', { done: p.done, total: p.total });
                }, abort.signal);
                if (abort.signal.aborted)
                    return;
                stored = result.stored;
                if (result.failed)
                    notify(t('anki.mediaFailed', { n: result.failed }), 'warn', 6000);
            }
            const summary = addRows(rows, fileName.replace(/\.(apkg|colpkg)$/i, ''), stored);
            notify(t('anki.done', { added: summary.added, updated: summary.updated, sets: summary.setIds.length }), 'ok', 5000);
            finish(summary.setIds);
        };
        wrap.addEventListener('click', e => {
            const action = e.target.closest('[data-anki]')?.dataset.anki;
            if (action === 'cancel')
                finish([]); // also stops an upload in progress
            if (action === 'import')
                void run();
        });
        document.body.append(wrap);
        q('[data-anki="import"]')?.focus();
    });
}
