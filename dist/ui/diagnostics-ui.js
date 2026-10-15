// "Copy diagnostics" (Settings footer): diagnostics.ts's report with what only
// the running page knows: the Polyglot version (HOST.version: the manifest in
// SillyTavern, built in elsewhere), the connection type, where the data is kept. Copied to the
// clipboard, or shown to copy by hand where the browser refuses (a SillyTavern
// opened over plain http on another device).
import { HOST } from '../host.js';
import { t } from '../i18n.js';
import { el, notify, showDocument } from '../ui.manager.js';
import { diagnosticsReport } from '../diagnostics.js';
import { getSettings, getLang } from '../runtime.js';
import { storeMode } from '../data-store.js';
async function polyglotVersion() {
    try {
        return await HOST.version();
    }
    catch {
        return '?';
    }
}
/** The report's facts. No keys and no addresses: only names of things. */
async function facts() {
    const s = getSettings();
    return {
        'Polyglot': await polyglotVersion(),
        'Connection': s.provider === 'st' || s.provider === 'profile' || !s.model ? s.provider : `${s.provider} (${s.model})`,
        'Storage': storeMode(),
        'Study language': getLang(),
        'Browser': navigator.userAgent,
        'Time': new Date().toISOString(),
    };
}
export async function copyDiagnostics() {
    const text = diagnosticsReport(await facts());
    try {
        await navigator.clipboard.writeText(text);
        notify(t('diag.copied'), 'ok', 4000);
    }
    catch {
        showDocument(t('diag.title'), el('pre', { className: 'pg-licenses-text', textContent: text }));
    }
}
