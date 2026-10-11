// "Find duplicates": groups of the same word among the visible entries
// (case / spacing variants, a form and its base word), merged one group
// at a time or all at once. The first entry of a group is kept.
import { html, setHtml } from '../../html.js';
import { t } from '../../i18n.js';
import { notify } from '../../ui.manager.js';
import { duplicateGroups, mergeDuplicates } from '../../wordbook.js';
/** Renders the duplicate groups into `el`; `changed` re-renders the wordbook after a merge. */
export function showDuplicates(el, changed) {
    const groups = duplicateGroups();
    el.hidden = false;
    setHtml(el, groups.length ? html `
        <div class="pg-wb-dupes-head">
            <b>${t('wb.dupTitle', { n: groups.length })}</b>
            <button class="pg-wb-row-btn" data-dupes="all">${t('wb.dupMergeAll')}</button>
            <button class="pg-wb-row-btn" data-dupes="close">${t('wb.dupClose')}</button>
        </div>
        <ul class="pg-wb-dupes-list">${groups.map((g, i) => html `
            <li>
                <span class="pg-wb-dupes-keep">${g[0].word}</span>
                <span class="pg-wb-dupes-rest">← ${g.slice(1).map(e => e.word).join(', ')}</span>
                <button class="pg-wb-row-btn" data-dupes="${i}">${t('wb.dupMerge')}</button>
            </li>`)}
        </ul>` : html `
        <div class="pg-wb-dupes-head">
            <span>${t('wb.dupNone')}</span>
            <button class="pg-wb-row-btn" data-dupes="close">${t('wb.dupClose')}</button>
        </div>`);
    el.onclick = ev => {
        const action = ev.target.closest('[data-dupes]')?.dataset.dupes;
        if (!action)
            return;
        if (action === 'close') {
            el.hidden = true;
            return;
        }
        const chosen = action === 'all' ? groups : [groups[Number(action)]].filter(Boolean);
        const n = chosen.reduce((sum, g) => sum + mergeDuplicates(g.map(e => e.word)), 0);
        if (n)
            notify(t('wb.dupMerged', { n }), 'ok', 3000);
        changed();
        showDuplicates(el, changed);
    };
}
