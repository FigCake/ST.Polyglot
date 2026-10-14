// The settings tab's voice section: which voice reads words aloud (tts.ts).
//
//   service ─┬─ browser / SillyTavern (its TTS extension, by voice name)
//            └─ ElevenLabs · Google · OpenAI-compatible · Fish Audio:
//               key, voice (with a list where the service has one), model,
//               speed, keep the sound on the word, send through ST's proxy
//   character voices   a voice per character of the open chat, for the lines' ▶
//                      (voice-cast.ts); with ST's TTS, its own voice map is used
//   [Try]    reads a greeting in the study language
//
// Fields write settings through the tab's data-setting handler; changing the
// service redraws the rows below it.
import { html, setHtml } from '../../html.js';
import { t } from '../../i18n.js';
import { getSettings, getLang } from '../../runtime.js';
import { notify } from '../../ui.manager.js';
import { tryVoice, voiceList, notifyVoiceError } from '../../voice.js';
import { castVoice, setCastVoice, castNames, chatCharacters } from '../../voice-cast.js';
import { browserVoices, speechLangCode } from '../../speech.js';
import { DEFAULTS, DIRECT_PROVIDERS, VOICE_SPEEDS, DEFAULT_VOICE_SPEED } from '../../tts.js';
/** Services: a translated name (`key`) or a brand name (`name`). */
const PROVIDERS = [
    { value: 'browser', key: 'tts.pBrowser' },
    { value: 'st', key: 'tts.pSt' },
    { value: 'elevenlabs', name: 'ElevenLabs' },
    { value: 'google', name: 'Google Cloud' },
    { value: 'openai', key: 'tts.pOpenai' },
    { value: 'fish', name: 'Fish Audio' },
];
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
        openai: html `
            ${field('voice_oa_url', t('tts.url'), s.voice_oa_url ?? '', DEFAULTS.openaiUrl)}
            ${keyField('voice_oa_key')}
            ${voiceField('voice_oa_voice', s.voice_oa_voice ?? '', DEFAULTS.openaiVoice, false)}
            ${field('voice_oa_model', t('tts.model'), s.voice_oa_model ?? '', DEFAULTS.openaiModel)}
            <span class="pg-pset-hint">${t('tts.hintOpenai')}</span>`,
        fish: html `
            ${keyField('voice_fish_key')}
            ${voiceField('voice_fish_voice', s.voice_fish_voice ?? '', t('tts.fishVoicePh'), false)}
            ${field('voice_fish_model', t('tts.model'), s.voice_fish_model ?? '', DEFAULTS.fishModel)}`,
    };
    const direct = DIRECT_PROVIDERS.includes(p);
    return html `
        ${rows[p] ?? rows.browser}
        ${direct && html `
        <label class="pg-pset-row">
            <span class="pg-pset-label">${t('tts.speed')}</span>
            <select class="text_pole pg-pset-select" data-setting="voice_speed">${VOICE_SPEEDS.map(v => html `
                <option value="${v}" ${v === (s.voice_speed ?? DEFAULT_VOICE_SPEED) && html `selected`}>${t(SPEED_LABELS[v])}</option>`)}
            </select>
        </label>
        <label class="pg-pset-row">
            <span class="pg-pset-label">${t('tts.save')}</span>
            <input type="checkbox" class="pg-pset-check" data-setting="voice_save" ${s.voice_save !== false && html `checked`}>
        </label>
        <label class="pg-pset-row">
            <span class="pg-pset-label">${t('tts.proxy')}</span>
            <input type="checkbox" class="pg-pset-check" data-setting="voice_proxy" ${!!s.voice_proxy && html `checked`}>
        </label>
        <span class="pg-pset-hint">${t('tts.hintProxy')}</span>`}
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
/** The section's body: the service picker and its rows. */
export function voiceSection(s) {
    return html `
        <label class="pg-pset-row">
            <span class="pg-pset-label">${t('tts.service')}</span>
            <select class="text_pole pg-pset-select" data-setting="voice_provider">${PROVIDERS.map(o => html `
                <option value="${o.value}" ${o.value === (s.voice_provider ?? 'browser') && html `selected`}>${'key' in o ? t(o.key) : o.name}</option>`)}
            </select>
        </label>
        <div class="pg-voice-rows">${serviceRows(s)}</div>`;
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
/** Wires the section: the saved keys, redraw on a service change, the voice list, the try button. Call after the tab's own handlers. */
export function bindVoiceSettings(root) {
    root.addEventListener('change', e => {
        if (e.target.dataset?.setting !== 'voice_provider')
            return;
        const rows = root.querySelector('.pg-voice-rows');
        if (rows) {
            setHtml(rows, serviceRows(getSettings()));
            fillKeys(rows);
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
