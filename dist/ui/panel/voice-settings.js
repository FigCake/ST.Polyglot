// The settings tab's voice section: everything spoken and heard, in one place.
//
//   reads aloud ─┬─ browser / SillyTavern (its TTS extension) / the app's own (Marinara)
//                └─ ElevenLabs · Google · OpenAI · Fish Audio: voice, model, speed,
//                   keep the sound on the word, send through ST's proxy
//      character voices   a voice per character of the open chat (voice-cast.ts)
//      [Try]              reads a greeting in the study language
//   hears you     the browser's recognition / Azure scores / OpenAI transcription (speech.ts)
//   AI advice     a button under a recorded check's result
//   connections   only those the choices need, each once: OpenAI (shared by all three;
//                 empty key = SillyTavern's saved one, or the AI connection's) and Azure
//
// Fields write settings through the tab's data-setting handler; a choice
// redraws the rows that depend on it.
import { html, setHtml } from '../../html.js';
import { t } from '../../i18n.js';
import { getSettings, getLang } from '../../runtime.js';
import { notify } from '../../ui.manager.js';
import { tryVoice, voiceList, notifyVoiceError } from '../../voice.js';
import { castVoice, setCastVoice, castNames, chatCharacters } from '../../voice-cast.js';
import { browserVoices, speechLangCode } from '../../speech.js';
import { DEFAULTS, DIRECT_PROVIDERS, VOICE_SPEEDS, DEFAULT_VOICE_SPEED } from '../../tts.js';
import { HOST } from '../../host.js';
import { OPENAI_URL, STT_MODEL, ADVICE_MODEL } from '../../openai-speech.js';
import { secret_state, SECRET_KEYS } from '../../st.js';
/** Services: a translated name (`key`) or a brand name (`name`). */
const PROVIDERS = [
    { value: 'browser', key: 'tts.pBrowser' },
    { value: 'host', key: 'tts.pHost' },
    { value: 'st', key: 'tts.pSt' },
    { value: 'elevenlabs', name: 'ElevenLabs' },
    { value: 'google', name: 'Google Cloud' },
    { value: 'openai', key: 'tts.pOpenai' },
    { value: 'fish', name: 'Fish Audio' },
    // SillyTavern's voices exist only there; an app's own voice service only in that app (Marinara)
].filter(p => (HOST.stVoice || p.value !== 'st') && (HOST.ai || p.value !== 'host'));
const SPEED_LABELS = { '0.75': 'tts.speedSlow', '0.9': 'tts.speedLittle', '1': 'tts.speedNormal' };
const field = (setting, name, value, placeholder = '') => html `
    <label class="pg-pset-field">
        <span class="pg-pset-label">${name}</span>
        <input type="text" class="text_pole" data-setting="${setting}" value="${value}" placeholder="${placeholder}"
               autocomplete="off" spellcheck="false">
    </label>`;
/** An API key field. The key is filled in after drawing (fillKeys), so it never sits in the page's HTML. */
const keyField = (setting) => html `
    <label class="pg-pset-field">
        <span class="pg-pset-label">${t('tts.key')}</span>
        <input type="password" class="text_pole" data-setting="${setting}" data-key-field autocomplete="new-password" spellcheck="false">
    </label>`;
/** Puts the saved keys into the key fields. */
function fillKeys(root) {
    const s = getSettings();
    root.querySelectorAll('input[data-key-field]').forEach(input => {
        input.value = String(s[input.dataset.setting ?? ''] ?? '');
    });
}
/** A voice field with a "list" button filling its suggestions (services that have a voice list). */
const voiceField = (setting, value, placeholder, withList) => html `
    <div class="pg-pset-field">
        <span class="pg-pset-label">${t('tts.voice')}</span>
        <div class="pg-voice-pick">
            <input type="text" class="text_pole" data-setting="${setting}" value="${value}" placeholder="${placeholder}"
                   autocomplete="off" spellcheck="false" list="pg-voice-list" aria-label="${t('tts.voice')}">
            ${withList && html `<button class="pg-btn pg-btn-secondary pg-btn-compact" data-voice="list">${t('tts.voiceList')}</button>`}
        </div>
        <datalist id="pg-voice-list"></datalist>
    </div>`;
/** The rows for the chosen service. */
function serviceRows(s) {
    const p = s.voice_provider ?? 'browser';
    const rows = {
        browser: html `<span class="pg-pset-hint">${t('tts.hintBrowser')}</span>`,
        host: html `
            ${voiceField('voice_host_voice', s.voice_host_voice ?? '', t('tts.hostVoicePh'), true)}
            <span class="pg-pset-hint">${t('tts.hintHost', { name: HOST.ai?.name ?? '' })}</span>`,
        st: html `
            ${field('voice_st_voice', t('tts.stVoice'), s.voice_st_voice ?? '', t('tts.stVoicePh'))}
            <span class="pg-pset-hint">${t('tts.hintSt')}</span>`,
        elevenlabs: html `
            ${keyField('voice_el_key')}
            ${voiceField('voice_el_voice', s.voice_el_voice ?? '', t('tts.voiceIdPh'), true)}
            ${field('voice_el_model', t('tts.model'), s.voice_el_model ?? '', DEFAULTS.elevenlabsModel)}`,
        google: html `
            ${keyField('voice_gg_key')}
            ${voiceField('voice_gg_voice', s.voice_gg_voice ?? '', t('tts.voiceDefaultPh'), true)}`,
        // Its key, address and model are in the OpenAI connection below (shared with transcription and advice)
        openai: html `
            ${voiceField('voice_oa_voice', s.voice_oa_voice ?? '', DEFAULTS.openaiVoice, false)}`,
        fish: html `
            ${keyField('voice_fish_key')}
            ${voiceField('voice_fish_voice', s.voice_fish_voice ?? '', t('tts.fishVoicePh'), false)}
            ${field('voice_fish_model', t('tts.model'), s.voice_fish_model ?? '', DEFAULTS.fishModel)}`,
    };
    const direct = DIRECT_PROVIDERS.includes(p);
    return html `
        ${rows[p] ?? rows.browser}
        ${direct && html `
        ${p !== 'host' && html `<label class="pg-pset-row">
            <span class="pg-pset-label">${t('tts.speed')}</span>
            <select class="text_pole pg-pset-select" data-setting="voice_speed">${VOICE_SPEEDS.map(v => html `
                <option value="${v}" ${v === (s.voice_speed ?? DEFAULT_VOICE_SPEED) && html `selected`}>${t(SPEED_LABELS[v])}</option>`)}
            </select>
        </label>`}
        <label class="pg-pset-row">
            <span class="pg-pset-label">${t('tts.save')}</span>
            <input type="checkbox" class="pg-pset-check" data-setting="voice_save" ${s.voice_save !== false && html `checked`}>
        </label>
        ${HOST.stVoice && html `<label class="pg-pset-row">
            <span class="pg-pset-label">${t('tts.proxy')}</span>
            <input type="checkbox" class="pg-pset-check" data-setting="voice_proxy" ${!!s.voice_proxy && html `checked`}>
        </label>
        <span class="pg-pset-hint">${t('tts.hintProxy')}</span>`}`}
        <details class="pg-voice-cast">
            <summary>${t('cast.title')}</summary>
            <div class="pg-voice-cast-rows"></div>
        </details>
        <button class="pg-btn pg-btn-secondary pg-btn-block" data-voice="try">🔊 ${t('tts.try')}</button>`;
}
/** The character voice rows, drawn when opened (the open chat decides who is listed). */
function castRows(s) {
    const p = s.voice_provider ?? 'browser';
    if (p === 'st')
        return html `<span class="pg-pset-hint">${t('cast.hintSt')}</span>`;
    const names = [...new Set([...chatCharacters(), ...castNames(p)])];
    // Browser voices are listed here; a service's come from its "list" button above
    const list = p === 'browser' ? 'pg-cast-voices' : 'pg-voice-list';
    return html `
        ${names.length ? names.map(name => html `
        <label class="pg-pset-field">
            <span class="pg-pset-label">${name}</span>
            <input type="text" class="text_pole" data-cast="${name}" value="${castVoice(p, name)}" placeholder="${t('cast.default')}"
                   autocomplete="off" spellcheck="false" list="${list}">
        </label>`) : html `<span class="pg-pset-hint">${t('cast.none')}</span>`}
        ${p === 'browser' && html `<datalist id="pg-cast-voices">${browserVoices(speechLangCode(getLang())).map(v => html `<option value="${v}"></option>`)}</datalist>`}
        <span class="pg-pset-hint">${t('cast.hint')}</span>`;
}
const PRON_ENGINES = [
    { value: 'browser', key: 'pron.engineBrowser' },
    { value: 'azure', key: 'pron.engineAzure' },
    { value: 'openai', key: 'pron.engineOpenai' },
];
const selectRow = (setting, label, value, options) => html `
    <label class="pg-pset-row">
        <span class="pg-pset-label">${label}</span>
        <select class="text_pole pg-pset-select" data-setting="${setting}">${options.map(o => html `
            <option value="${o.value}" ${o.value === value && html `selected`}>${o.label}</option>`)}
        </select>
    </label>`;
const checkRow = (setting, label, on) => html `
    <label class="pg-pset-row">
        <span class="pg-pset-label">${label}</span>
        <input type="checkbox" class="pg-pset-check" data-setting="${setting}" ${on && html `checked`}>
    </label>`;
/**
 * The connections the choices above need, each asked for once: OpenAI (reading
 * aloud, transcription and advice share it; an empty key means SillyTavern's
 * saved one or the AI connection's; models and address folded under
 * "Advanced") and Azure (scores).
 */
function connectionRows(s) {
    const engine = s.pron_engine ?? 'browser';
    const readsOpenAi = s.voice_provider === 'openai', hearsOpenAi = engine === 'openai', advice = !!s.pron_advice;
    // An empty key means SillyTavern's saved one (or the AI connection's): say when there is none
    const stNoKey = HOST.stConnection && !(s.voice_oa_key ?? '').trim() && !(s.voice_oa_url ?? '').trim() && !secret_state[SECRET_KEYS.OPENAI];
    return html `
        ${advice && engine === 'browser' && html `<span class="pg-pset-hint">${t('pron.adviceNeedsRec')}</span>`}
        ${(readsOpenAi || hearsOpenAi || advice) && html `
        <div class="pg-voice-conn-block">
            <span class="pg-pset-label pg-voice-conn-title">OpenAI</span>
            ${keyField('voice_oa_key')}
            <span class="pg-pset-hint">${t(HOST.stConnection ? 'voice.keyFallbackSt' : 'voice.keyFallback')}</span>
            ${stNoKey && html `<span class="pg-pset-hint">${t('voice.useStNone')}</span>`}
            <details class="pg-voice-adv">
                <summary>${t('voice.advanced')}</summary>
                ${field('voice_oa_url', t('tts.url'), s.voice_oa_url ?? '', OPENAI_URL)}
                ${readsOpenAi && field('voice_oa_model', t('voice.ttsModel'), s.voice_oa_model ?? '', DEFAULTS.openaiModel)}
                ${hearsOpenAi && field('pron_stt_model', t('pron.sttModel'), s.pron_stt_model ?? '', STT_MODEL)}
                ${advice && field('pron_advice_model', t('pron.adviceModel'), s.pron_advice_model ?? '', ADVICE_MODEL)}
                <span class="pg-pset-hint">${t('pron.hintOpenai')}</span>
            </details>
        </div>`}
        ${engine === 'azure' && html `
        <div class="pg-voice-conn-block">
            <span class="pg-pset-label pg-voice-conn-title">Azure</span>
            ${keyField('pron_azure_key')}
            ${field('pron_azure_region', t('pron.region'), s.pron_azure_region ?? '', t('pron.regionPh'))}
            <span class="pg-pset-hint">${t('pron.hint')}</span>
        </div>`}`;
}
/**
 * The section's body: what reads aloud (and its rows), what hears you, the
 * advice switch, then the connections those choices need.
 */
export function voiceSection(s) {
    return html `
        ${selectRow('voice_provider', t('tts.service'), s.voice_provider ?? 'browser', PROVIDERS.map(o => ({ value: o.value, label: 'key' in o ? t(o.key, { name: HOST.ai?.name ?? '' }) : o.name })))}
        <div class="pg-voice-rows">${serviceRows(s)}</div>
        ${selectRow('pron_engine', t('pron.engine'), s.pron_engine ?? 'browser', PRON_ENGINES.map(o => ({ value: o.value, label: t(o.key) })))}
        ${checkRow('pron_advice', t('pron.adviceToggle'), !!s.pron_advice)}
        <div class="pg-voice-conn">${connectionRows(s)}</div>`;
}
/** Fills the voice suggestions from the service's list. */
async function fillVoiceList(root, btn) {
    const list = root.querySelector('#pg-voice-list');
    if (!list)
        return;
    btn.disabled = true;
    try {
        const voices = await voiceList(getLang());
        setHtml(list, html `${voices.map(v => html `<option value="${v.id}">${v.label}</option>`)}`);
        notify(t('tts.voicesFound', { n: voices.length }), 'info', 3000);
        root.querySelector('.pg-voice-pick input')?.focus();
    }
    catch (e) {
        notifyVoiceError(e);
    }
    finally {
        btn.disabled = false;
    }
}
/** Wires the section: the saved keys, redraw on a service change, the voice list, the try button, the pronunciation rows. Call after the tab's own handlers. */
export function bindVoiceSettings(root) {
    // A choice redraws what depends on it: the service's rows, and the connections the choices need
    const REDRAWS_CONNECTIONS = new Set(['voice_provider', 'pron_engine', 'pron_advice']);
    root.addEventListener('change', e => {
        const setting = e.target.dataset?.setting ?? '';
        if (setting === 'voice_provider') {
            const rows = root.querySelector('.pg-voice-rows');
            if (rows) {
                setHtml(rows, serviceRows(getSettings()));
                fillKeys(rows);
            }
        }
        if (REDRAWS_CONNECTIONS.has(setting)) {
            const conn = root.querySelector('.pg-voice-conn');
            if (conn) {
                setHtml(conn, connectionRows(getSettings()));
                fillKeys(conn);
            }
        }
    });
    fillKeys(root);
    // Character voices: drawn on opening, saved as typed (not data-setting fields)
    root.addEventListener('toggle', e => {
        const box = e.target;
        if (!box.matches?.('.pg-voice-cast') || !box.open)
            return;
        const rows = box.querySelector('.pg-voice-cast-rows');
        if (rows)
            setHtml(rows, castRows(getSettings()));
    }, true);
    root.addEventListener('change', e => {
        const input = e.target;
        if (input.dataset?.cast === undefined)
            return;
        setCastVoice(getSettings().voice_provider ?? 'browser', input.dataset.cast, input.value);
    });
    root.addEventListener('click', e => {
        const btn = e.target.closest('button[data-voice]');
        if (!btn)
            return;
        if (btn.dataset.voice === 'try')
            tryVoice(getLang());
        else
            void fillVoiceList(root, btn);
    });
}
