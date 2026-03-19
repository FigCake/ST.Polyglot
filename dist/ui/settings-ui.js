// ════════════════════════════
// Polyglot  ui/settings-ui.ts
// ════════════════════════════
// Settings panel — HTML rendering, event binding, provider/model UI.
//
// Design rules:
//   • _s() / _save() / getLang() / getNativeLang() / callModel()
//     are injected via SettingsDeps so this module has no dependency on
//     index.ts internals.
//   • clearAllConjCache
//     are injected for the "clear" buttons.
//
// Dependencies: constants.ts, types.ts, api.ts, ui.manager.ts
import { PROVIDER_MODELS, ROUTE_MODEL_KEY } from '../api.js';
import { escapeHtml, notify } from '../ui.manager.js';
import { t } from '../i18n.js';
// @ts-expect-error — no type declarations for ST internals
import { getContext } from '../../../../../extensions.js';
// ── Injected deps ─────────────────────────────────────────────────────────────
let _deps = null;
export function initSettingsUI(deps) {
    _deps = deps;
}
function _s() { if (!_deps)
    throw new Error('[Polyglot] settings-ui used before init'); return _deps.getSettings(); }
function _save() { _deps?.save(); }
function _buildProviderModelRows(s) {
    const isKnown = s.provider in PROVIDER_MODELS;
    const isST = s.provider === 'st';
    const isCustom = s.provider === 'custom';
    // ST default mode: read-only display of the current ST connection.
    // route_chat_source / route_model are advanced overrides, collapsed by default.
    const hasOverride = !!(s.route_chat_source || s.route_model);
    const stRows = `
        <div id="pg-row-st" style="${isST ? '' : 'display:none;'}">
            <div class="pg-st-info-box">
                <span class="pg-st-info-icon">🔗</span>
                <span class="pg-st-info-text">${t('set.stDesc')}<br>
                <span id="pg-st-live-source" class="pg-st-live"></span></span>
            </div>
            <div style="margin-top:5px;">
                <label style="font-size:0.82em;opacity:0.6;cursor:pointer;display:flex;align-items:center;gap:5px;">
                    <input type="checkbox" id="pg-chk-st-override" ${hasOverride ? 'checked' : ''}>
                    ${t('set.stAdvanced')}
                </label>
            </div>
            <div id="pg-st-override-rows" style="${hasOverride ? '' : 'display:none;'}margin-top:6px;">
                <div class="flex-container flexGap5" style="margin-bottom:4px;">
                    <label for="pg-inp-route-source" style="min-width:70px;font-size:0.85em;">Source</label>
                    <input type="text" id="pg-inp-route-source" class="text_pole" placeholder="e.g. vertexai, makersuite, openai…" value="${escapeHtml(s.route_chat_source)}" style="flex:1;">
                </div>
                <div class="flex-container flexGap5">
                    <label for="pg-inp-route-model" style="min-width:70px;font-size:0.85em;">Model</label>
                    <input type="text" id="pg-inp-route-model" class="text_pole" placeholder="${t('set.stModelPh')}" value="${escapeHtml(s.route_model)}" style="flex:1;">
                </div>
            </div>
        </div>`;
    // Known provider: dropdown list + free-text fallback
    const knownModels = isKnown ? PROVIDER_MODELS[s.provider] : [];
    const isCustomModel = s.model && !knownModels.includes(s.model);
    const modelOptions = knownModels
        .map(m => `<option value="${escapeHtml(m)}"${s.model === m ? ' selected' : ''}>${escapeHtml(m)}</option>`)
        .join('');
    const knownRows = `
        <div id="pg-row-known" style="${isKnown ? '' : 'display:none;'}margin-bottom:6px;">
            <div class="flex-container flexGap5" style="margin-bottom:4px;">
                <label for="pg-sel-model" style="min-width:70px;">Model</label>
                <select id="pg-sel-model" class="text_pole" style="flex:1;">
                    ${modelOptions}
                    <option value="__custom__"${isCustomModel ? ' selected' : ''}>${t('set.modelManual')}</option>
                </select>
            </div>
            <div id="pg-row-model-custom" style="${isCustomModel ? '' : 'display:none;'}margin-top:3px;">
                <input type="text" id="pg-inp-model-custom" class="text_pole"
                    placeholder="${t('set.modelPh')}"
                    value="${escapeHtml(isCustomModel ? s.model : '')}"
                    style="width:100%;" autocomplete="off" spellcheck="false">
            </div>
        </div>`;
    // Custom provider settings
    const customRows = `
        <div id="pg-row-custom-api" style="${isCustom ? '' : 'display:none;'}margin-bottom:6px;">
            <div class="flex-container flexGap5" style="margin-bottom:4px;">
                <label for="pg-inp-ext-url" style="min-width:70px;">Base URL</label>
                <input type="text" id="pg-inp-ext-url" class="text_pole" placeholder="https://..." value="${escapeHtml(s.ext_base_url)}" style="flex:1;">
            </div>
            <div class="flex-container flexGap5" style="margin-bottom:4px;">
                <label for="pg-inp-ext-key" style="min-width:70px;">API Key</label>
                <input type="password" id="pg-inp-ext-key" class="text_pole" placeholder="sk-..." autocomplete="off" style="flex:1;">
            </div>
            <div class="flex-container flexGap5">
                <label for="pg-inp-ext-model" style="min-width:70px;">Model</label>
                <input type="text" id="pg-inp-ext-model" class="text_pole" placeholder="Model name" value="${escapeHtml(s.model)}" style="flex:1;">
            </div>
        </div>`;
    return stRows + knownRows + customRows;
}
export function buildSettingsPanel() {
    const extContainer = document.getElementById('extensions_settings');
    if (!extContainer || document.getElementById('pg-settings-panel'))
        return;
    const s = _s();
    const wrapper = document.createElement('div');
    wrapper.id = 'pg-settings-panel';
    wrapper.className = 'extension_container';
    wrapper.innerHTML = `
        <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🌐 Polyglot</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display:none;">

            <!-- Feature toggles -->
            <div class="flex-container flexGap5" style="margin-bottom:6px;">
                <label class="checkbox_label"><input type="checkbox" id="pg-chk-checker" ${s.enabled_checker ? 'checked' : ''}><span>${t('set.checker')}</span></label>
                <label class="checkbox_label"><input type="checkbox" id="pg-chk-annotator" ${s.enabled_annotator ? 'checked' : ''}><span>${t('set.aiStudy')}</span></label>
            </div>

            <!-- Target language -->
            <div class="flex-container flexGap5" style="margin-bottom:6px;">
                <label for="pg-sel-lang">${t('set.targetLang')}</label>
                <select id="pg-sel-lang" class="text_pole">
                    <option value="English"  ${s.language === 'English' ? 'selected' : ''}>🇺🇸 English</option>
                    <option value="Spanish"  ${s.language === 'Spanish' ? 'selected' : ''}>🇪🇸 Spanish</option>
                    <option value="Japanese" ${s.language === 'Japanese' ? 'selected' : ''}>🇯🇵 Japanese</option>
                    <option value="Italian"  ${s.language === 'Italian' ? 'selected' : ''}>🇮🇹 Italian</option>
                    <option value="French"   ${s.language === 'French' ? 'selected' : ''}>🇫🇷 French</option>
                    <option value="German"   ${s.language === 'German' ? 'selected' : ''}>🇩🇪 German</option>
                    <option value="Chinese"  ${s.language === 'Chinese' ? 'selected' : ''}>🇨🇳 Chinese</option>
                    <option value="Korean"   ${s.language === 'Korean' ? 'selected' : ''}>🇰🇷 Korean</option>
                    <option value="Custom"   ${s.language === 'Custom' ? 'selected' : ''}>✏️ Custom</option>
                </select>
            </div>
            <div id="pg-row-lang-custom" style="${s.language === 'Custom' ? '' : 'display:none'};margin-bottom:6px;">
                <input type="text" id="pg-inp-lang-custom" class="text_pole" placeholder="${t('set.langCustomPh')}" value="${escapeHtml(s.language_custom)}">
            </div>

            <!-- Explanation language (native language) -->
            <div class="flex-container flexGap5" style="margin-bottom:6px;">
                <label for="pg-sel-native-lang">${t('set.explainLang')}</label>
                <select id="pg-sel-native-lang" class="text_pole">
                    <option value="en" ${s.native_lang === 'en' ? 'selected' : ''}>🇺🇸 English</option>
                    <option value="es" ${s.native_lang === 'es' ? 'selected' : ''}>🇪🇸 Spanish</option>
                    <option value="it" ${s.native_lang === 'it' ? 'selected' : ''}>🇮🇹 Italian</option>
                    <option value="ko" ${s.native_lang === 'ko' ? 'selected' : ''}>🇰🇷 Korean</option>
                    <option value="custom" ${s.native_lang === 'custom' ? 'selected' : ''}>✏️ Custom</option>
                </select>
            </div>
            <div id="pg-row-native-lang-custom" style="${s.native_lang === 'custom' ? '' : 'display:none'};margin-bottom:6px;">
                <input type="text" id="pg-inp-native-lang-custom" class="text_pole" placeholder="${t('set.nativeLangPh')}" value="${escapeHtml(s.native_lang_custom ?? '')}">
            </div>

            <!-- CEFR level -->
            <div class="flex-container flexGap5" style="margin-bottom:6px;">
                <label for="pg-sel-cefr">${t('set.cefrLevel')}</label>
                <select id="pg-sel-cefr" class="text_pole">
                    ${['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(l => `<option value="${l}" ${s.cefr_level === l ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </div>

            <!-- AI provider -->
            <div style="border-top:1px solid var(--SmartThemeBorderColor, #555);margin:8px 0 8px;"></div>
            <div class="flex-container flexGap5" style="margin-bottom:6px;">
                <label for="pg-sel-provider">${t('set.aiProvider')}</label>
                <select id="pg-sel-provider" class="text_pole" style="flex:1;">
                    <option value="st"         ${s.provider === 'st' ? 'selected' : ''}>${t('set.stDefault')}</option>
                    <option value="openai"     ${s.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
                    <option value="claude"     ${s.provider === 'claude' ? 'selected' : ''}>Claude (Anthropic)</option>
                    <option value="google"     ${s.provider === 'google' ? 'selected' : ''}>Google Gemini (AI Studio)</option>
                    <option value="vertexai"   ${s.provider === 'vertexai' ? 'selected' : ''}>Google Vertex AI</option>
                    <option value="openrouter" ${s.provider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                    <option value="deepseek"   ${s.provider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
                    <option value="custom"     ${s.provider === 'custom' ? 'selected' : ''}>⚙️ Custom</option>
                </select>
            </div>
            <div id="pg-provider-detail">
                ${_buildProviderModelRows(s)}
            </div>

            <!-- Max tokens -->
            <div style="border-top:1px solid var(--SmartThemeBorderColor, #555);margin:8px 0 8px;"></div>
            <div style="margin-bottom:6px;">
                <label>${t('set.maxTokens')} <span id="pg-tokens-display"><b>${s.max_tokens}</b></span></label>
                <div class="flex-container flexGap5" style="align-items:center;">
                    <input type="range"  id="pg-rng-tokens" min="500" max="100000" step="500" value="${s.max_tokens}" style="flex:1;">
                    <input type="number" id="pg-num-tokens" class="text_pole" min="500" max="100000" step="500" value="${s.max_tokens}" style="width:70px;">
                </div>
            </div>

        </div>`;
    extContainer.appendChild(wrapper);
    // ═ Inject sensitive field values via JS — keeps keys out of DOM source
    const _keyInp = wrapper.querySelector('#pg-inp-ext-key');
    if (_keyInp)
        _keyInp.value = _s().ext_api_key;
    // ═ Event bindings
    const body = wrapper;
    body.querySelector('#pg-chk-checker')?.addEventListener('change', e => {
        const on = e.target.checked;
        _s().enabled_checker = on;
        _save();
        document.dispatchEvent(new CustomEvent('pg:checker-toggle', { detail: { on } }));
    });
    body.querySelector('#pg-chk-annotator')?.addEventListener('change', e => {
        const on = e.target.checked;
        _s().enabled_annotator = on;
        _save();
        document.dispatchEvent(new CustomEvent('pg:annotator-toggle', { detail: { on } }));
    });
    body.querySelector('#pg-sel-lang')?.addEventListener('change', e => {
        const newLang = e.target.value;
        const oldLang = _s().language;
        _s().language = newLang;
        _save();
        body.querySelector('#pg-row-lang-custom').style.display = newLang === 'Custom' ? '' : 'none';
        // Clear conjugation cache when the learning language changes —
        // tables for the old language are no longer valid.
        if (newLang !== oldLang) {
            _deps?.clearAllConjCache().then(() => {
                notify(t('set.langChanged'), 'info', 3000);
            });
        }
    });
    body.querySelector('#pg-inp-lang-custom')?.addEventListener('input', e => { _s().language_custom = e.target.value; _save(); });
    // ═ Explanation language (native language)
    body.querySelector('#pg-sel-native-lang')?.addEventListener('change', e => {
        const val = e.target.value;
        _s().native_lang = val;
        _save();
        body.querySelector('#pg-row-native-lang-custom').style.display =
            val === 'custom' ? '' : 'none';
    });
    body.querySelector('#pg-inp-native-lang-custom')?.addEventListener('input', e => {
        _s().native_lang_custom = e.target.value;
        _save();
    });
    body.querySelector('#pg-sel-cefr')?.addEventListener('change', e => { _s().cefr_level = e.target.value; _save(); });
    // ═ Provider selector
    body.querySelector('#pg-sel-provider')?.addEventListener('change', e => {
        const s = _s();
        const provider = e.target.value;
        // Save the current model to history before switching
        if (s.provider in PROVIDER_MODELS && s.model) {
            s._model_history[s.provider] = s.model;
        }
        s.provider = provider;
        // Restore the last-used model for the new provider
        if (provider in PROVIDER_MODELS) {
            s.model = s._model_history[provider] || PROVIDER_MODELS[provider][0] || '';
            s._model_history[provider] = s.model;
        }
        _save();
        // Re-render the provider detail section
        const detailEl = body.querySelector('#pg-provider-detail');
        if (detailEl) {
            detailEl.innerHTML = _buildProviderModelRows(s);
            _bindProviderDetailEvents(body);
        }
    });
    _bindProviderDetailEvents(body);
    // ═ Token slider
    const rng = body.querySelector('#pg-rng-tokens'), num = body.querySelector('#pg-num-tokens'), disp = body.querySelector('#pg-tokens-display');
    const syncTokens = (v) => {
        const n = Math.max(500, Math.min(100000, parseInt(String(v)) || 4000));
        rng.value = String(n);
        num.value = String(n);
        if (disp)
            disp.innerHTML = `<b>${n}</b>`;
        _s().max_tokens = n;
        _save();
    };
    rng?.addEventListener('input', e => syncTokens(e.target.value));
    num?.addEventListener('change', e => syncTokens(e.target.value));
    /** Renders the current ST connection info into the live-display element. */
    function _renderSTLiveDisplay(liveEl) {
        const s = _s();
        const ccs = getContext().chatCompletionSettings ?? {};
        const src = ccs.chat_completion_source || '(none)';
        const model = ccs[ROUTE_MODEL_KEY.get(src) || 'model'] || ccs.model || '';
        if (s.route_chat_source || s.route_model) {
            liveEl.innerHTML =
                `Active: <b>${escapeHtml(s.route_chat_source || src)}</b>` +
                    ` / <b>${escapeHtml(s.route_model || model || 'default')}</b>` +
                    ` <span style="color:#e07070;font-size:0.85em;">${t('set.advOverrideActive')}</span>`;
        }
        else {
            liveEl.innerHTML =
                `ST connection: <b>${escapeHtml(src)}</b>` +
                    (model ? ` / <b>${escapeHtml(model)}</b>` : '');
        }
    }
    // Provider detail events — re-bound whenever the provider changes
    function _bindProviderDetailEvents(body) {
        // ST default mode — live display of the current ST connection
        const liveEl = body.querySelector('#pg-st-live-source');
        if (liveEl)
            _renderSTLiveDisplay(liveEl);
        // Advanced override toggle
        body.querySelector('#pg-chk-st-override')?.addEventListener('change', e => {
            const overrideRows = body.querySelector('#pg-st-override-rows');
            if (overrideRows)
                overrideRows.style.display = e.target.checked ? '' : 'none';
            if (!e.target.checked) {
                // Unchecked — clear the saved override values
                const s = _s();
                s.route_chat_source = '';
                s.route_model = '';
                _save();
                // Clear the input fields too
                const srcInp = body.querySelector('#pg-inp-route-source');
                const mdlInp = body.querySelector('#pg-inp-route-model');
                if (srcInp)
                    srcInp.value = '';
                if (mdlInp)
                    mdlInp.value = '';
                // Refresh the live display
                const liveEl2 = body.querySelector('#pg-st-live-source');
                if (liveEl2)
                    _renderSTLiveDisplay(liveEl2);
            }
        });
        body.querySelector('#pg-inp-route-source')?.addEventListener('input', e => { _s().route_chat_source = e.target.value.trim(); _save(); });
        body.querySelector('#pg-inp-route-model')?.addEventListener('input', e => { _s().route_model = e.target.value.trim(); _save(); });
        // Known provider model — dropdown + free-text input
        body.querySelector('#pg-sel-model')?.addEventListener('change', e => {
            const s = _s();
            const val = e.target.value;
            const customRow = body.querySelector('#pg-row-model-custom');
            const customInp = body.querySelector('#pg-inp-model-custom');
            if (val === '__custom__') {
                if (customRow)
                    customRow.style.display = '';
                if (customInp)
                    customInp.focus();
            }
            else {
                if (customRow)
                    customRow.style.display = 'none';
                s.model = val;
                if (s.provider in PROVIDER_MODELS)
                    s._model_history[s.provider] = val;
                _save();
            }
        });
        body.querySelector('#pg-inp-model-custom')?.addEventListener('input', e => {
            const s = _s();
            s.model = e.target.value.trim();
            if (s.provider in PROVIDER_MODELS)
                s._model_history[s.provider] = s.model;
            _save();
        });
        // Custom provider
        body.querySelector('#pg-inp-ext-url')?.addEventListener('input', e => { _s().ext_base_url = e.target.value.trim(); _save(); });
        body.querySelector('#pg-inp-ext-key')?.addEventListener('input', e => { _s().ext_api_key = e.target.value.trim(); _save(); });
        body.querySelector('#pg-inp-ext-model')?.addEventListener('input', e => { _s().model = e.target.value.trim(); _save(); });
    }
}
