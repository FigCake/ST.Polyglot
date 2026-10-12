// The edit form's sounds: for the word and its example, what it has (a
// recording, a voice service's sound, none) with Play, Make (again) and
// Remove. They act at once, apart from the form's Save.
//
// Replacing or removing a recording (from Anki) asks first: it cannot be made again.
import { html } from '../../html.js';
import { t } from '../../i18n.js';
import { askConfirm, notify } from '../../ui.manager.js';
import { getLang } from '../../runtime.js';
import { loadWordbook, setWordSound } from '../../wordbook.js';
import { speak, notifyVoiceError } from '../../voice.js';
import { soundsOffered, remakeWordSound } from '../../sound-maker.js';
import { SOUND_FIELDS, soundText, soundJob, hasSound, isMadeSound } from '../../word-sounds.js';
import { checkSoundsReady } from '../sound-notices.js';
const LABEL = { audio: 'snd.word', example_audio: 'snd.example' };
/** A row button; its accessible name says which sound it acts on ("Remove — Example"). */
const button = (action, label, field, danger = false) => html `
    <button type="button" class="pg-wb-row-btn ${danger && 'pg-wb-row-btn-danger'}" data-sound="${action}"
            aria-label="${t(label)} — ${t(LABEL[field])}">${t(label)}</button>`;
function row(e, field, canMake) {
    const text = soundText(e, field);
    const has = hasSound(e, field);
    const state = !text ? 'snd.noExample' : !has ? 'snd.empty' : isMadeSound(e, field) ? 'snd.madeTag' : 'snd.recording';
    return html `
        <div class="pg-wb-sound-row" data-field="${field}">
            <span class="pg-wb-sound-name">${t(LABEL[field])}</span>
            <span class="pg-wb-sound-state">${t(state)}</span>
            ${has && button('play', 'snd.play', field)}
            ${text && canMake && button('make', has ? 'snd.remake' : 'snd.makeOne', field)}
            ${has && button('remove', 'snd.remove', field, true)}
        </div>`;
}
/** The sounds block for the entry; empty when it has none and none can be made. */
export function soundRows(e) {
    const canMake = soundsOffered();
    if (!canMake && !SOUND_FIELDS.some(f => hasSound(e, f)))
        return html ``;
    return html `
        <div class="pg-wb-sounds">
            <span class="pg-wb-sounds-title">${t('snd.section')}</span>
            ${SOUND_FIELDS.map(f => row(e, f, canMake))}
        </div>`;
}
const entryOf = (word) => loadWordbook().find(w => w.word === word);
/** A recording is replaced or removed only after a yes. */
const allowed = (e, field, question, yes) => !hasSound(e, field) || isMadeSound(e, field) ? Promise.resolve(true) : askConfirm(t(question), { yes: t(yes), no: t('confirmNo') });
async function make(word, field) {
    if (!checkSoundsReady())
        return false;
    const e = entryOf(word);
    if (!e || !(await allowed(e, field, 'snd.replaceRecording', 'snd.remake')))
        return false;
    // The word as it is now: what the new sound may replace
    const job = soundJob(entryOf(word) ?? e, field, getLang());
    if (!job)
        return false;
    try {
        const result = await remakeWordSound(job);
        if (result !== 'stored') {
            notify(t('snd.notKept'), 'err', 4000);
            return false;
        }
        notify(t('snd.remade'), 'ok', 2500);
        speak(job.text, job.lang, { audio: entryOf(word)?.[field] });
        return true;
    }
    catch (err) {
        notifyVoiceError(err);
        return false;
    }
}
async function remove(word, field) {
    const e = entryOf(word);
    if (!e || !(await allowed(e, field, 'snd.removeRecording', 'snd.remove')))
        return false;
    return setWordSound(word, field, null);
}
/** Wires the block inside `form` for `word`; it redraws itself after a change. */
export function bindSoundRows(form, word) {
    form.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('button[data-sound]');
        const field = btn?.closest('.pg-wb-sound-row')?.dataset.field;
        const e = entryOf(word);
        if (!btn || btn.disabled || !field || !e)
            return;
        if (btn.dataset.sound === 'play') {
            speak(soundText(e, field), getLang(), { audio: e[field] });
            return;
        }
        // Disabled before any wait, so a double click cannot make (and pay for) two sounds
        btn.disabled = true;
        const changed = btn.dataset.sound === 'make' ? await make(word, field) : await remove(word, field);
        btn.disabled = false;
        const block = form.querySelector('.pg-wb-sounds');
        const fresh = entryOf(word);
        if (changed && block && fresh)
            block.outerHTML = soundRows(fresh).value;
    });
}
