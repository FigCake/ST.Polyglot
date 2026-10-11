// The Polyglot drawer in SillyTavern's Extensions settings: features, languages,
// CEFR level, AI provider / model, max tokens.
//
//   • Plain inputs carry data-setting="<key>" and are saved by one delegated
//     handler (data-trim trims the value first); side effects of a change live
//     in SETTING_EFFECTS, as in ui/panel/settings-tab.ts.
//   • The provider and model selects, the connection override and max tokens
//     have their own handlers in bind().
//   • The provider block is re-rendered when the provider changes.
import { CEFR_LEVELS } from '../constants.js';
import { PROVIDER_MODELS, ROUTE_MODEL_KEY } from '../api.js';
import { html, setHtml } from '../html.js';
import { t } from '../i18n.js';
import { notify } from '../ui.manager.js';
import { getSettings, saveSettings, getContext, getLang } from '../runtime.js';
import { isJapanese } from '../utils.js';
import { clearAllConjCache } from '../wordbook.js';
import { ST_SEL } from '../st-dom.js';
const TOKENS = { min: 500, max: 100_000, step: 500, fallback: 4000 };
const CUSTOM_MODEL = '__custom__';
const LANGUAGES = [
    ['English', '🇺🇸 English'], ['Spanish', '🇪🇸 Spanish'], ['Japanese', '🇯🇵 Japanese'],
    ['Italian', '🇮🇹 Italian'], ['French', '🇫🇷 French'], ['German', '🇩🇪 German'],
    ['Chinese', '🇨🇳 Chinese'], ['Korean', '🇰🇷 Korean'], ['Custom', '✏️ Custom'],
];
const NATIVE_LANGUAGES = [
    ['en', '🇺🇸 English'], ['es', '🇪🇸 Spanish'], ['it', '🇮🇹 Italian'], ['ko', '🇰🇷 Korean'], ['custom', '✏️ Custom'],
];
const PROVIDERS = [
    ['st', ''], // label from i18n
    ['openai', 'OpenAI'], ['claude', 'Claude (Anthropic)'], ['google', 'Google Gemini (AI Studio)'],
    ['vertexai', 'Google Vertex AI'], ['openrouter', 'OpenRouter'], ['deepseek', 'DeepSeek'], ['custom', '⚙️ Custom'],
];
// ── Markup helpers ────────────────────────────────────────────────────────────
const options = (list, selected) => html `${list.map(([value, label]) => html `<option value="${value}" ${value === selected && html `selected`}>${label}</option>`)}`;
const field = (label, control) => html `
    <div class="flex-container flexGap5 pg-set-field"><label>${label}</label>${control}</div>`;
const textInput = (setting, value, placeholder, extra) => html `
    <input type="text" class="text_pole" data-setting="${setting}" data-trim value="${value}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" ${extra}>`;
// ── Provider block ────────────────────────────────────────────────────────────
function stRows(s) {
    const override = !!(s.route_chat_source || s.route_model);
    return html `
        <div class="pg-st-info-box">
            <span class="pg-st-info-icon">🔗</span>
            <span class="pg-st-info-text">${t('set.stDesc')}<br><span class="pg-st-live"></span></span>
        </div>
        <label class="pg-set-override-toggle">
            <input type="checkbox" class="pg-st-override" ${override && html `checked`}> ${t('set.stAdvanced')}
        </label>
        <div class="pg-st-override-rows" ${!override && html `hidden`}>
            ${field('Source', textInput('route_chat_source', s.route_chat_source, 'e.g. vertexai, makersuite, openai…'))}
            ${field('Model', textInput('route_model', s.route_model, t('set.stModelPh')))}
        </div>`;
}
function knownProviderRows(s) {
    const models = PROVIDER_MODELS[s.provider] ?? [];
    const manual = !!s.model && !models.includes(s.model);
    return html `
        ${field('Model', html `
            <select class="text_pole pg-model-select">
                ${options(models.map(m => [m, m]), manual ? CUSTOM_MODEL : s.model)}
                <option value="${CUSTOM_MODEL}" ${manual && html `selected`}>${t('set.modelManual')}</option>
            </select>`)}
        <div class="pg-model-manual" ${!manual && html `hidden`}>
            ${textInput('model', manual ? s.model : '', t('set.modelPh'), html `data-remember-model`)}
        </div>`;
}
function customProviderRows(s) {
    return html `
        ${field('Base URL', textInput('ext_base_url', s.ext_base_url, 'https://...'))}
        ${field('API Key', html `<input type="password" class="text_pole pg-api-key" data-setting="ext_api_key" data-trim placeholder="sk-..." autocomplete="off">`)}
        ${field('Model', textInput('model', s.model, 'Model name'))}`;
}
function providerRows(s) {
    if (s.provider === 'st')
        return stRows(s);
    if (s.provider === 'custom')
        return customProviderRows(s);
    if (s.provider in PROVIDER_MODELS)
        return knownProviderRows(s);
    return html ``;
}
/** "ST connection: source / model", or the active override. */
function renderLiveConnection(root) {
    const el = root.querySelector('.pg-st-live');
    if (!el)
        return;
    const s = getSettings();
    const ccs = getContext().chatCompletionSettings ?? {};
    const source = ccs.chat_completion_source || '(none)';
    const model = ccs[ROUTE_MODEL_KEY.get(source) || 'model'] || ccs.model || '';
    setHtml(el, s.route_chat_source || s.route_model
        ? html `Active: <b>${s.route_chat_source || source}</b> / <b>${s.route_model || model || 'default'}</b>
               <span class="pg-st-override-note">${t('set.advOverrideActive')}</span>`
        : html `ST connection: <b>${source}</b>${model && html ` / <b>${model}</b>`}`);
}
function renderProvider(root) {
    const block = root.querySelector('.pg-provider-detail');
    if (!block)
        return;
    setHtml(block, providerRows(getSettings()));
    // Secrets are set as properties, never written into markup
    const key = block.querySelector('.pg-api-key');
    if (key)
        key.value = getSettings().ext_api_key;
    renderLiveConnection(root);
}
// ── Panel markup ──────────────────────────────────────────────────────────────
function panel(s) {
    return html `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🌐 Polyglot</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display:none;">
                <div class="flex-container flexGap5 pg-set-field">
                    <label class="checkbox_label"><input type="checkbox" data-setting="enabled_checker" ${s.enabled_checker && html `checked`}><span>${t('set.checker')}</span></label>
                    <label class="checkbox_label"><input type="checkbox" data-setting="enabled_annotator" ${s.enabled_annotator && html `checked`}><span>${t('set.aiStudy')}</span></label>
                    <label class="checkbox_label" title="${t('set.dialogueOnlyHint')}"><input type="checkbox" data-setting="dialogue_only" ${s.dialogue_only && html `checked`}><span>${t('set.dialogueOnly')}</span></label>
                </div>

                ${field(t('set.targetLang'), html `<select class="text_pole" data-setting="language">${options(LANGUAGES, s.language)}</select>`)}
                <div class="pg-set-field pg-lang-custom" ${s.language !== 'Custom' && html `hidden`}>
                    <input type="text" class="text_pole" data-setting="language_custom" value="${s.language_custom}" placeholder="${t('set.langCustomPh')}">
                </div>
                <div class="pg-set-field pg-furi-toggle" ${!isJapanese(getLang()) && html `hidden`}>
                    <label class="checkbox_label" title="${t('set.furiganaHint')}">
                        <input type="checkbox" data-setting="furigana_enabled" ${s.furigana_enabled !== false && html `checked`}>
                        <span>${t('set.furigana')}</span>
                    </label>
                </div>

                ${field(t('set.explainLang'), html `<select class="text_pole" data-setting="native_lang">${options(NATIVE_LANGUAGES, s.native_lang)}</select>`)}
                <div class="pg-set-field pg-native-custom" ${s.native_lang !== 'custom' && html `hidden`}>
                    <input type="text" class="text_pole" data-setting="native_lang_custom" value="${s.native_lang_custom ?? ''}" placeholder="${t('set.nativeLangPh')}">
                </div>

                ${field(t('set.cefrLevel'), html `<select class="text_pole" data-setting="cefr_level">${options(CEFR_LEVELS.map(l => [l, l]), s.cefr_level)}</select>`)}

                <hr class="pg-set-divider">
                ${field(t('set.aiProvider'), html `
                    <select class="text_pole pg-provider-select">${options(PROVIDERS.map(([v, l]) => [v, l || t('set.stDefault')]), s.provider)}</select>`)}
                <div class="pg-provider-detail"></div>

                <hr class="pg-set-divider">
                <div class="pg-set-field">
                    <label>${t('set.maxTokens')} <b class="pg-tokens-display">${s.max_tokens}</b></label>
                    <div class="flex-container flexGap5 pg-tokens-row">
                        <input type="range"  class="pg-tokens" min="${TOKENS.min}" max="${TOKENS.max}" step="${TOKENS.step}" value="${s.max_tokens}">
                        <input type="number" class="text_pole pg-tokens" min="${TOKENS.min}" max="${TOKENS.max}" step="${TOKENS.step}" value="${s.max_tokens}">
                    </div>
                </div>
            </div>
        </div>`;
}
// ── Behaviour ─────────────────────────────────────────────────────────────────
const show = (root, selector, visible) => {
    const el = root.querySelector(selector);
    if (el)
        el.hidden = !visible;
};
/** "Use furigana" is offered only for Japanese; features re-check what they show. */
function languageChanged(root) {
    show(root, '.pg-furi-toggle', isJapanese(getLang()));
    document.dispatchEvent(new CustomEvent('pg:language-change'));
}
/** What else must happen when a setting changes. */
const SETTING_EFFECTS = {
    enabled_checker: (_, on) => document.dispatchEvent(new CustomEvent('pg:checker-toggle', { detail: { on } })),
    enabled_annotator: (_, on) => document.dispatchEvent(new CustomEvent('pg:annotator-toggle', { detail: { on } })),
    language: (root, value, previous) => {
        show(root, '.pg-lang-custom', value === 'Custom');
        languageChanged(root);
        // Cached conjugation tables belong to the previous language
        if (value !== previous)
            clearAllConjCache().then(() => notify(t('set.langChanged'), 'info', 3000));
    },
    language_custom: root => languageChanged(root),
    furigana_enabled: () => document.dispatchEvent(new CustomEvent('pg:language-change')),
    native_lang: (root, value) => show(root, '.pg-native-custom', value === 'custom'),
    route_chat_source: root => renderLiveConnection(root),
    route_model: root => renderLiveConnection(root),
};
function rememberModel(s) {
    if (s.provider in PROVIDER_MODELS)
        s._model_history[s.provider] = s.model;
}
function onSettingInput(root, el) {
    const key = el.dataset.setting;
    const s = getSettings();
    const previous = s[key];
    const value = el instanceof HTMLInputElement && el.type === 'checkbox'
        ? el.checked
        : 'trim' in el.dataset ? el.value.trim() : el.value;
    s[key] = value;
    if ('rememberModel' in el.dataset)
        rememberModel(s);
    saveSettings();
    SETTING_EFFECTS[key]?.(root, value, previous);
}
function onProviderChange(root, provider) {
    const s = getSettings();
    if (s.provider in PROVIDER_MODELS && s.model)
        s._model_history[s.provider] = s.model;
    s.provider = provider;
    if (provider in PROVIDER_MODELS) {
        s.model = s._model_history[provider] || PROVIDER_MODELS[provider][0] || '';
        rememberModel(s);
    }
    saveSettings();
    renderProvider(root);
}
function onModelSelect(root, value) {
    const manual = value === CUSTOM_MODEL;
    show(root, '.pg-model-manual', manual);
    if (manual) {
        root.querySelector('.pg-model-manual input')?.focus();
        return;
    }
    const s = getSettings();
    s.model = value;
    rememberModel(s);
    saveSettings();
}
function onOverrideToggle(root, on) {
    show(root, '.pg-st-override-rows', on);
    if (on)
        return;
    // Turning the override off clears it
    Object.assign(getSettings(), { route_chat_source: '', route_model: '' });
    saveSettings();
    root.querySelectorAll('.pg-st-override-rows input').forEach(i => { i.value = ''; });
    renderLiveConnection(root);
}
function setTokens(root, raw) {
    const n = Math.max(TOKENS.min, Math.min(TOKENS.max, parseInt(raw, 10) || TOKENS.fallback));
    root.querySelectorAll('.pg-tokens').forEach(i => { i.value = String(n); });
    const display = root.querySelector('.pg-tokens-display');
    if (display)
        display.textContent = String(n);
    getSettings().max_tokens = n;
    saveSettings();
}
function bind(root) {
    const handle = (e) => {
        const el = e.target;
        if (el.dataset.setting)
            onSettingInput(root, el);
        else if (el.matches('.pg-provider-select'))
            onProviderChange(root, el.value);
        else if (el.matches('.pg-model-select'))
            onModelSelect(root, el.value);
        else if (el.matches('.pg-st-override'))
            onOverrideToggle(root, el.checked);
    };
    // Text saves as you type; everything else on change
    root.addEventListener('input', e => {
        const el = e.target;
        if (el.matches('.pg-tokens[type="range"]'))
            setTokens(root, el.value);
        else if (el.type === 'text' || el.type === 'password')
            handle(e);
    });
    root.addEventListener('change', e => {
        const el = e.target;
        if (el.matches('.pg-tokens[type="number"]'))
            setTokens(root, el.value);
        else if (el.type !== 'text' && el.type !== 'password')
            handle(e);
    });
}
/** Adds the Polyglot drawer to ST's extension settings (once). */
export function buildSettingsPanel() {
    const host = document.querySelector(ST_SEL.extensionsSettings);
    if (!host || document.getElementById('pg-settings-panel'))
        return;
    const root = Object.assign(document.createElement('div'), { id: 'pg-settings-panel', className: 'extension_container' });
    setHtml(root, panel(getSettings()));
    host.appendChild(root);
    renderProvider(root);
    bind(root);
}
