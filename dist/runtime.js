// Live settings access and the helpers that are bound to them.
//
// Design rules:
//   • This is the only module that creates / back-fills / migrates settings.
//     Other modules either import getSettings() from here or receive it via deps.
//   • extension_settings is imported directly (not via getContext()) because
//     some ST versions hand out a snapshot from getContext().extensionSettings.
import { KEY } from './constants.js';
import { getLangFromSettings, getNativeLangFromSettings } from './utils.js';
import { complete } from './api.js';
import { createAiClient } from './ai/client.js';
import { defaultModels } from './ai/providers.js';
import { notify } from './ui.manager.js';
import { t } from './i18n.js';
import { HOST } from './host.js';
import { extension_settings, getContext, saveSettingsDebounced } from './st.js';
// ── Defaults ──────────────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = Object.freeze({
    enabled_checker: true,
    enabled_annotator: true,
    language: 'English',
    language_custom: '',
    native_lang: 'en', // explanation / UI language: 'ko'|'en'|'it'|'es'|'custom'
    native_lang_custom: '',
    cefr_level: 'B1',
    // provider: 'st' | 'profile' | 'host' | 'openai' | 'claude' | 'google' | 'openrouter' | 'deepseek' | 'vertexai' | 'custom'
    provider: 'st',
    model: '', // selected model name (unused when provider is 'st')
    // last-used model per provider — restored when switching back to a provider
    _model_history: defaultModels(),
    // API keys by provider, outside SillyTavern only (HOST.ownKeys)
    own_keys: {},
    // ST default connection only (provider='st')
    route_chat_source: '',
    route_model: '',
    // SillyTavern connection profile only (provider='profile')
    profile_id: '',
    // The app's own connection (provider='host'; Marinara): '' = the open chat's
    host_connection: '',
    // Custom provider only (provider='custom')
    ext_api_key: '',
    ext_base_url: '',
    max_tokens: 30000,
    dict_url_custom: '',
    panel_theme: 'dark',
    panel_bg_image: '',
    panel_floating: false,
    auto_save_idioms: true,
    srs_new_per_day: 20,
    voice_provider: 'browser',
    voice_speed: '0.9',
    voice_save: true,
    voice_proxy: false,
    voice_st_voice: '',
    voice_host_voice: '',
    pron_engine: 'browser', pron_azure_key: '', pron_azure_region: '',
    pron_stt_model: '', pron_advice: false, pron_advice_model: '',
    voice_el_key: '', voice_el_voice: '', voice_el_model: '',
    voice_gg_key: '', voice_gg_voice: '',
    voice_oa_key: '', voice_oa_voice: '', voice_oa_model: '', voice_oa_url: '',
    voice_fish_key: '', voice_fish_voice: '', voice_fish_model: '',
    dialogue_only: false,
    para_translate: 'button',
    para_translate_wishes: '',
    mark_saved_words: true,
    line_voice: true,
    voice_cast: {},
    wordbook_scope: 'chat',
    wordbook_lang_only: true,
    wordbook_hide_known: true,
    furigana_enabled: true,
    furigana_display: 'show',
    furigana_size: 0.65,
    furigana_auto: false,
    skip_names: true,
    skip_words: '',
    skip_tags: 'status, info',
    skip_blocks: true,
    skip_brackets: true,
    // Learner data (wordbook, sets, wrong answers) is not a setting — see data-store.ts
});
const LEGACY_PROVIDER_MAP = {
    anthropic: 'claude', openai: 'openai', openrouter: 'openrouter', custom: 'custom',
};
// ── Settings access ───────────────────────────────────────────────────────────
/** Settings objects already back-filled and migrated: once each, not at every one of the many reads. */
const prepared = new WeakSet();
/** Returns the live settings object, creating, back-filling and migrating it the first time it is seen. */
export function getSettings() {
    extension_settings[KEY.module] ??= structuredClone(DEFAULT_SETTINGS);
    const s = extension_settings[KEY.module];
    if (!prepared.has(s)) {
        prepareSettings(s);
        prepared.add(s);
    }
    return s;
}
/** Back-fills keys added since and migrates old values (on first use, and after a backup's settings are restored). */
export function prepareSettings(s) {
    migrateVoiceOpenAi(s);
    backfillDefaults(s);
    migrateLegacyProvider(s);
    migrateFurigana(s);
    dropRemovedTts(s);
    leaveStOnlyChoices(s);
}
/**
 * Outside SillyTavern its connection, profiles, Vertex AI and voices do not exist: the
 * first choice that does (the app's own connections where it has them). Nor do the
 * app's own connections anywhere else.
 */
function leaveStOnlyChoices(s) {
    if (!HOST.stConnection && ['st', 'profile', 'vertexai'].includes(s.provider)) {
        s.provider = HOST.ai ? 'host' : 'openrouter';
        s.model = HOST.ai ? s.model : s._model_history.openrouter ?? '';
    }
    if (!HOST.ai && s.provider === 'host')
        s.provider = HOST.stConnection ? 'st' : 'openrouter';
    if (!HOST.stVoice && s.voice_provider === 'st')
        s.voice_provider = HOST.ai ? 'host' : 'browser';
    if (!HOST.ai && s.voice_provider === 'host')
        s.voice_provider = 'browser';
}
export function saveSettings() { saveSettingsDebounced(); }
/** Applies a partial update to the live settings and schedules a save. */
export function updateSettings(patch) {
    Object.assign(getSettings(), patch);
    saveSettings();
}
/** Adds keys introduced by newer versions to settings saved by older ones. */
function backfillDefaults(s) {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (Object.hasOwn(s, k))
            continue;
        s[k] = Array.isArray(v) ? [] : (v && typeof v === 'object') ? { ...v } : v;
    }
    for (const [provider, model] of Object.entries(DEFAULT_SETTINGS._model_history)) {
        s._model_history[provider] ||= model;
    }
}
/** Legacy migration: ext_provider / ext_model → provider / model. */
function migrateLegacyProvider(s) {
    if (!Object.hasOwn(s, 'ext_provider'))
        return;
    const legacy = s.ext_provider;
    if (legacy && legacy !== 'none') {
        s.provider = LEGACY_PROVIDER_MAP[legacy] ?? 'st';
        if (s.ext_model)
            s.model = s.ext_model;
    }
    delete s.ext_provider;
    delete s.ext_model;
}
/** Pre-release furigana settings: a "hidden" display (now the "Use furigana" switch), older size steps, dictionary keys. */
const OLD_FURIGANA_SIZES = { 0.45: 0.5, 0.55: 0.65, 0.7: 0.8 };
function migrateFurigana(s) {
    if (s.furigana_display === 'hide') {
        s.furigana_display = 'show';
        s.furigana_enabled = false;
    }
    s.furigana_size = OLD_FURIGANA_SIZES[s.furigana_size] ?? s.furigana_size;
    // Left by the removed local dictionary
    delete s.furigana_dict;
    delete s.furigana_source;
}
/**
 * One OpenAI connection for voice: a key entered for pronunciation alone (a
 * development build) moves to the voice key, which reading aloud already uses.
 */
function migrateVoiceOpenAi(s) {
    const old = s;
    // Only to the address it was used with: a key must not start going to another server
    const sameAddress = !s.voice_oa_url || s.voice_oa_url === old.pron_oa_url;
    if (old.pron_oa_key && !s.voice_oa_key && sameAddress) {
        s.voice_oa_key = old.pron_oa_key;
        s.voice_oa_url ||= old.pron_oa_url ?? '';
    }
    delete old.pron_oa_key;
    delete old.pron_oa_url;
}
/** The text-to-speech engines removed in March 2026 left their settings behind, API keys included. */
function dropRemovedTts(s) {
    for (const key of Object.keys(s))
        if (key.startsWith('tts_'))
            delete s[key];
}
/** ST context accessor, re-exported so nested modules need no deep relative ST paths. */
export { getContext };
// ── Settings-bound helpers ────────────────────────────────────────────────────
export const getLang = () => getLangFromSettings(getSettings());
export const getNativeLang = () => getNativeLangFromSettings(getSettings());
const client = createAiClient((system, user, signal) => complete(getSettings(), system, user, signal));
/** One plain request (no JSON, no retry) to the provider chosen in settings. */
export const completeText = (system, user, signal = null) => complete(getSettings(), system, user, signal);
/**
 * The shared AI client, bound to the current provider settings.
 * A result recovered from a cut-off reply, or still missing fields after the
 * retry, is still returned, with a notice.
 */
export const ai = {
    async json(request) {
        const result = await client.json(request);
        if (result.missing?.length)
            notify(t('ai.missing'), 'warn', 5000);
        else if (result.partial)
            notify(t('ai.partial'), 'warn', 4000);
        return result;
    },
};
