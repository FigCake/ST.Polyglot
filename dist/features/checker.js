// Input checker / translator (🌍 button).
// Reads the ST send_textarea, calls the AI, and replaces the text with
// the corrected version + explanation if a correction was made.
//
// Design rules:
//   • No direct ST state reads — settings, lang, and the AI client are injected.
//   • setWandBusy is injected so this module has no dependency on index.ts.
import { checkerPrompt } from '../prompts.js';
import { notify } from '../ui.manager.js';
import { acceptObject } from '../ai/client.js';
import { t } from '../i18n.js';
import { ST_SEL } from '../st-dom.js';
// ── Module-level abort tracker ────────────────────────────────────────────────
let _checkerAbort = null;
// ── Public API ────────────────────────────────────────────────────────────────
/** Checks the input box; shows "Looks good ✓" when nothing needs correcting. */
export async function runChecker(deps) {
    const s = deps.getSettings();
    if (!s.enabled_checker)
        return;
    const textarea = document.querySelector(ST_SEL.sendTextarea);
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
        const { data: result } = await deps.ai.json({
            prompt: checkerPrompt(text, deps.getLang(), s.cefr_level, deps.getNativeLang()),
            signal: abort.signal,
            accept: (acceptObject),
        });
        if (abort.signal.aborted)
            return;
        const corrected = result.corrected_text?.trim() ?? '';
        // The box may have been sent, cleared or typed in meanwhile: never write over that
        if (corrected && corrected !== text && textarea.value.trim() !== text) {
            notify(t('chk.changed', { text: corrected }), 'info', 10000);
        }
        else if (corrected && corrected !== text) {
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
        // A newer check (a second click) owns the busy state now
        if (_checkerAbort === abort) {
            _checkerAbort = null;
            deps.setWandBusy(false);
        }
    }
}
