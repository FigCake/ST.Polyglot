// ════════════════════════════
// Polyglot  features/checker.ts
// ════════════════════════════
// Input checker / translator (🌍 button).
// Reads the ST send_textarea, calls the AI, and replaces the text with
// the corrected version + explanation if a correction was made.
//
// Design rules:
//   • No direct ST state reads — settings, lang, and callModel are injected.
//   • setWandBusy is injected so this module has no dependency on index.ts.
//   • notify and parseJSON are imported directly (no side effects).
//
// Dependencies: constants.ts, prompts.ts, utils.ts, ui.manager.ts
import { API } from '../constants.js';
import { checkerPrompt } from '../prompts.js';
import { parseJSON } from '../utils.js';
import { notify } from '../ui.manager.js';
import { t } from '../i18n.js';
// ── Module-level abort tracker ────────────────────────────────────────────────
let _checkerAbort = null;
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Reads the ST send_textarea, sends it to the AI checker, and replaces
 * the content with the corrected text + explanation if a change was made.
 * Shows a "Looks good ✓" notification when no correction is needed.
 */
export async function runChecker(deps) {
    const s = deps.getSettings();
    if (!s.enabled_checker)
        return;
    const textarea = document.getElementById('send_textarea');
    if (!(textarea instanceof HTMLTextAreaElement))
        return;
    const text = textarea.value.trim();
    if (!text)
        return;
    // Abort any previous in-flight check (rapid button clicks)
    _checkerAbort?.abort();
    const abort = new AbortController();
    _checkerAbort = abort;
    deps.setWandBusy(true);
    try {
        const result = parseJSON(await deps.callModel(API.sysJson, checkerPrompt(text, deps.getLang(), s.cefr_level, deps.getNativeLang()), abort.signal));
        if (abort.signal.aborted)
            return;
        const corrected = result.corrected_text?.trim() ?? '';
        if (corrected && corrected !== text) {
            // Insert corrected text + explanation back into the input box
            const explanation = result.explanation ? `\n--\n${result.explanation}` : '';
            textarea.value = corrected + explanation;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        else {
            notify(t('chk.looksGood'), 'ok', 2000);
        }
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        console.error('[Polyglot] Checker error:', e);
        notify(t('chk.error'), 'err', 3000);
    }
    finally {
        if (_checkerAbort === abort)
            _checkerAbort = null;
        deps.setWandBusy(false);
    }
}
