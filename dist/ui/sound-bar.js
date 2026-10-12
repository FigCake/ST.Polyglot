// "Make sounds" for chosen words: asks which sounds to make (the missing ones,
// or also the made ones, again with the current voice), then makes them one
// at a time with a progress strip and a Stop button (sound-maker.ts).
import { t } from '../i18n.js';
import { askChoice, notify } from '../ui.manager.js';
import { loadWordbook } from '../wordbook.js';
import { getLang } from '../runtime.js';
import { runSounds, isSoundRunActive, stopSoundRun } from '../sound-maker.js';
import { planSounds, planChars, planCounts } from '../word-sounds.js';
import { openRunProgress } from './run-progress.js';
import { checkSoundsReady } from './sound-notices.js';
/** Asks what to make: 'missing', 'remake', or null (nothing to make, or cancelled). */
async function askMode(missing, remake) {
    // Made sounds the run could remake (recordings are never in the plan)
    const remade = remake.length - missing.length;
    if (!missing.length && !remade) {
        notify(t('snd.none'), 'info', 3000);
        return null;
    }
    const counts = planCounts(missing);
    const question = [
        missing.length
            ? t('snd.askMissing', { words: counts.audio, examples: counts.example_audio, chars: planChars(missing).toLocaleString() })
            : t('snd.allHave'),
        remade > 0 ? t('snd.askRemake', { n: remade }) : '',
        t('snd.cost'),
    ].filter(Boolean).join('\n\n');
    const choices = [{ value: 'no', label: t('confirmNo') }];
    if (remade > 0)
        choices.push({ value: 'remake', label: t('snd.remakeAll'), primary: !missing.length });
    if (missing.length)
        choices.push({ value: 'missing', label: t('snd.makeMissing'), primary: true });
    const answer = await askChoice(question, choices);
    return answer === 'no' ? null : answer;
}
const ERROR_TEXT = {
    upload: () => t('snd.uploadFailed'),
    storage: () => t('snd.needStorage'),
};
function notifyResult(r, total) {
    const msg = r.error && (ERROR_TEXT[r.error]?.() ?? r.error);
    if (r.gaveUp)
        notify(t('snd.failed', { done: r.made, total, msg: msg ?? '' }), 'err', 6000);
    else if (r.stopped)
        notify(t('snd.stopped', { done: r.made, total }), 'warn', 3000);
    else if (r.failed)
        notify(t('snd.doneSome', { n: r.made, failed: r.failed, msg: msg ?? '' }), 'warn', 6000);
    else
        notify(t('snd.done', { n: r.made }), 'ok', 3000);
}
/** Plans the chosen words' sounds now (the wordbook may change while a question is open). */
const plan = (words, mode) => planSounds(loadWordbook().filter(e => words.has(e.word)), mode, getLang());
/** Asks, then makes the chosen words' sounds. One run at a time: Stop is on its progress strip. */
export async function startSoundRun({ bar, words, onDone }) {
    if (isSoundRunActive()) {
        notify(t('snd.running'), 'info', 3000);
        return;
    }
    if (!checkSoundsReady())
        return;
    const chosen = new Set(words);
    const mode = await askMode(plan(chosen, 'missing'), plan(chosen, 'remake'));
    // Another run may have started while the question was open
    if (!mode || isSoundRunActive())
        return;
    const jobs = plan(chosen, mode);
    const progress = openRunProgress(bar, t('snd.progress', { done: 0, total: jobs.length }), stopSoundRun);
    try {
        const result = await runSounds(jobs, mode === 'remake', (done, total) => progress.update(t('snd.progress', { done, total }), done, total));
        notifyResult(result, jobs.length);
    }
    finally {
        progress.close();
        onDone?.();
    }
}
