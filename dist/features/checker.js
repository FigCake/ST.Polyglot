// Input checker / translator (🌍 button).
// Reads the ST send_textarea, calls the AI, and replaces the text with the
// grammar-only fix and, under a --- line, a more natural version. The
// explanation goes to the correction archive (the Writing mode), not the box.
//
// Design rules:
//   • No direct ST state reads — settings, lang, the AI client and the archive are injected.
//   • setWandBusy is injected so this module has no dependency on index.ts.
import { checkerPrompt, CHECKER_FIELDS } from '../prompts.js';
import { notify } from '../ui.manager.js';
import { acceptObject, missingKeys } from '../ai/client.js';
import { t } from '../i18n.js';
import { errorText } from '../diagnostics.js';
import { ST_SEL } from '../st-dom.js';
/**
 * What goes into the input box: the grammar fix, then (when it differs) the
 * natural version under a --- line. Null when nothing needs changing.
 */
export function checkerText(original, grammar, natural) {
    const g = grammar.trim() || natural.trim();
    const n = natural.trim();
    if (!g || (g === original && (!n || n === original)))
        return null;
    return n && n !== g ? `${g}\n---\n${n}` : g;
}
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
            missing: v => missingKeys(v, CHECKER_FIELDS),
        });
        if (abort.signal.aborted)
            return;
        const str = (v) => (typeof v === 'string' ? v.trim() : '');
        const grammar = str(result.grammar), natural = str(result.natural);
        // Neither came, even when asked again: nothing to put in the box (the missing-fields notice says so)
        if (!grammar && !natural)
            return;
        const corrected = checkerText(text, grammar, natural);
        if (!corrected) {
            notify(t('chk.looksGood'), 'ok', 2000);
            return;
        }
        deps.archive({ lang: deps.langKey(), original: text, grammar: grammar || natural, natural, explanation: str(result.explanation) });
        // The box may have been sent, cleared or typed in meanwhile: never write over that
        if (textarea.value.trim() !== text) {
            notify(t('chk.changed', { text: corrected }), 'info', 10000);
        }
        else {
            textarea.value = corrected;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        console.error('[Polyglot] Checker error:', e);
        notify(`${t('chk.error')} (${errorText(e)})`, 'err', 6000);
    }
    finally {
        // A newer check (a second click) owns the busy state now
        if (_checkerAbort === abort) {
            _checkerAbort = null;
            deps.setWandBusy(false);
        }
    }
}
