// ════════════════════════════
// Polyglot  ui/licenses.ts
// ════════════════════════════
// "Open-source licenses": shows THIRD_PARTY_NOTICES.md (copied into dist at
// build time, next to this module's parent) in a dialog.
//
// The file is plain Markdown; only what it uses is rendered — headings, the
// summary table, and everything else as preformatted text. All text goes in
// through textContent.
//
// Dependencies: i18n.ts, ui.manager.ts
import { t } from '../i18n.js';
import { el, notify, showDocument } from '../ui.manager.js';
const NOTICES_URL = new URL('../THIRD_PARTY_NOTICES.md', import.meta.url);
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
/** Markdown (the subset the notices use) → elements. */
export function renderNotices(markdown) {
    const root = el('div', { className: 'pg-licenses' });
    const lines = markdown.replace(/\r/g, '').split('\n');
    let text = [];
    const flushText = () => {
        const body = text.join('\n').trim();
        if (body)
            root.append(el('pre', { className: 'pg-licenses-text', textContent: body }));
        text = [];
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const heading = /^(#{1,3})\s+(.*)$/.exec(line);
        if (heading) {
            flushText();
            root.append(el(heading[1].length === 1 ? 'h3' : 'h4', { textContent: heading[2] }));
            continue;
        }
        if (line.startsWith('|')) {
            flushText();
            const rows = [];
            for (; i < lines.length && lines[i].startsWith('|'); i++) {
                if (!/^\|[\s|:-]+\|$/.test(lines[i].trim()))
                    rows.push(cells(lines[i]));
            }
            i--;
            const [head, ...body] = rows;
            root.append(el('table', { className: 'pg-licenses-table' }, [
                el('thead', {}, [el('tr', {}, head.map(c => el('th', { textContent: c })))]),
                el('tbody', {}, body.map(r => el('tr', {}, r.map(c => el('td', { textContent: c }))))),
            ]));
            continue;
        }
        text.push(line.replace(/`/g, ''));
    }
    flushText();
    return root;
}
export async function showLicenses() {
    try {
        const res = await fetch(NOTICES_URL);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        showDocument(t('lic.title'), renderNotices(await res.text()));
    }
    catch (e) {
        notify(t('lic.failed', { msg: e instanceof Error ? e.message : String(e) }), 'err', 4000);
    }
}
