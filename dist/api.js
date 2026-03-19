// ════════════════════════════
// Polyglot  api.ts
// ════════════════════════════
// AI provider router — unified callModel entry point and per-provider backends.
//
// Design rules:
//   • No DOM, no ST state reads.  getSettings() is NOT called here.
//   • callModel() takes an explicit `s: Settings` so this module has zero
//     dependency on index.ts state.  The caller (index.ts) injects settings.
//   • ST imports are limited to getRequestHeaders / secret_state — both are
//     pure request utilities with no side effects.
//
// Dependencies: constants.ts, types.ts, ST internals (getRequestHeaders, secret_state)
// @ts-expect-error — no type declarations for ST internals
import { getRequestHeaders } from '../../../../../script.js';
// @ts-expect-error — no type declarations for ST internals
import { getContext } from '../../../../extensions.js';
// @ts-expect-error — no type declarations for ST internals
import { SECRET_KEYS, secret_state } from '../../../../secrets.js';
// ── Provider config tables ────────────────────────────────────────────────────
// Exported so settings-ui.ts can build the model dropdown without duplicating data.
/** Maps Polyglot provider key → ST chat_completion_source value. */
export const PROVIDER_SOURCE = {
    openai: 'openai',
    claude: 'claude',
    google: 'makersuite',
    openrouter: 'openrouter',
    deepseek: 'deepseek',
    vertexai: 'vertexai',
};
/** Per-provider model suggestions (autocomplete hints — any model string is accepted). */
export const PROVIDER_MODELS = {
    openai: [
        'gpt-5.2', 'gpt-5.1', 'gpt-5.1-chat-latest',
        'gpt-4o', 'gpt-4o-mini',
    ],
    claude: [
        'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
        'claude-3-5-sonnet-20241022',
    ],
    google: [
        'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview',
        'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
    ],
    openrouter: [
        'google/gemini-3.1-pro-preview', 'google/gemini-3-pro-preview', 'google/gemini-3-flash-preview',
        'google/gemini-2.5-pro', 'google/gemini-2.5-flash',
        'anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5',
        'openai/gpt-5.2', 'openai/gpt-5.1', 'openai/gpt-4o',
        'deepseek/deepseek-chat-v3-5', 'deepseek/deepseek-r2',
    ],
    deepseek: [
        'deepseek-chat-v3-5', 'deepseek-r2', 'deepseek-chat', 'deepseek-reasoner',
    ],
    vertexai: [
        'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview',
        'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
    ],
};
/** ST backend source → chatCompletionSettings model-key mapping. */
export const ROUTE_MODEL_KEY = new Map([
    ['openai', 'openai_model'],
    ['claude', 'claude_model'],
    ['makersuite', 'google_model'],
    ['vertexai', 'vertexai_model'],
    ['openrouter', 'openrouter_model'],
    ['mistralai', 'mistralai_model'],
    ['cohere', 'cohere_model'],
    ['deepseek', 'deepseek_model'],
    ['groq', 'groq_model'],
    ['custom', 'custom_model'],
]);
/** Maps provider key → ST SECRET_KEYS value (for pre-flight key validation). */
const PROVIDER_SECRET_KEY = {
    openai: SECRET_KEYS.OPENAI,
    claude: SECRET_KEYS.CLAUDE,
    google: SECRET_KEYS.MAKERSUITE,
    openrouter: SECRET_KEYS.OPENROUTER,
    deepseek: SECRET_KEYS.DEEPSEEK,
    // vertexai omitted — ST handles Express / Service Account auth internally
};
// ── Internal helpers ──────────────────────────────────────────────────────────
function _buildMessages(systemPrompt, userPrompt) {
    const messages = [];
    if (systemPrompt)
        messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });
    return messages;
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Unified model call entry point.
 *
 * Dispatches to the correct backend based on `s.provider`.
 * Does NOT call getSettings() — the caller must inject the current settings.
 * In index.ts a thin wrapper `callModel(sys, user, signal)` does the injection.
 *
 * @param s            Current Polyglot settings (injected by caller).
 * @param systemPrompt System / instruction prompt.
 * @param userPrompt   User message.
 * @param signal       Optional AbortSignal for cancellation.
 */
export async function callModel(s, systemPrompt, userPrompt, signal = null) {
    const provider = s.provider || 'st';
    if (provider === 'st')
        return callSTBackend(systemPrompt, userPrompt, s, signal);
    if (provider === 'custom')
        return callCustomAPI(systemPrompt, userPrompt, s, signal);
    // Vertex AI: route through callSTBackend so ST reads its own saved auth config
    // (Express key or Service Account). google_vertex_express is forwarded from
    // chatCompletionSettings so ST's backend picks the correct auth path.
    if (provider === 'vertexai') {
        return callSTBackend(systemPrompt, userPrompt, { ...s, route_chat_source: 'vertexai', route_model: s.model }, signal);
    }
    return callViaSTBackend(systemPrompt, userPrompt, s, signal);
}
/**
 * ST-default mode — uses whatever API connection ST is currently configured with.
 * Also used for Vertex AI (caller sets route_chat_source = 'vertexai').
 */
export async function callSTBackend(systemPrompt, userPrompt, s, signal) {
    const ctx = getContext();
    const ccs = ctx.chatCompletionSettings ?? {};
    const src = s.route_chat_source || ccs.chat_completion_source || 'openai';
    const modelKey = ROUTE_MODEL_KEY.get(src) || 'model';
    const model = s.route_model || ccs[modelKey] || '';
    const messages = _buildMessages(systemPrompt, userPrompt);
    let resp;
    try {
        resp = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            signal: signal ?? undefined,
            body: JSON.stringify({
                chat_completion_source: src,
                [modelKey]: model,
                model,
                messages,
                max_tokens: s.max_tokens,
                temperature: 0.3,
                stream: false,
                // Forward all Vertex AI config fields from ST's saved settings.
                ...(src === 'vertexai' && {
                    vertexai_auth_mode: ccs.vertexai_auth_mode ?? 'full',
                    vertexai_region: ccs.vertexai_region ?? 'global',
                    vertexai_express_project_id: ccs.vertexai_express_project_id ?? '',
                }),
            }),
        });
    }
    catch (fetchErr) {
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError')
            throw fetchErr;
        throw new Error('Network request failed. Make sure the SillyTavern server is running.');
    }
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`ST API ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? '';
}
/**
 * Known-provider mode — routes through ST backend with an explicit
 * chat_completion_source.  Reuses ST's stored API keys.
 */
export async function callViaSTBackend(systemPrompt, userPrompt, s, signal) {
    const chatSource = PROVIDER_SOURCE[s.provider];
    if (!chatSource)
        throw new Error(`Unknown provider: ${s.provider}`);
    if (!s.model)
        throw new Error('No model selected. Please choose a model in the settings.');
    // Pre-flight key check — gives faster, clearer error feedback
    const secretKey = PROVIDER_SECRET_KEY[s.provider];
    if (secretKey && !secret_state[secretKey]) {
        throw new Error(`${s.provider.toUpperCase()} API key is not set. Enter it in SillyTavern's API settings.`);
    }
    const messages = _buildMessages(systemPrompt, userPrompt);
    let resp;
    try {
        resp = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            signal: signal ?? undefined,
            body: JSON.stringify({
                chat_completion_source: chatSource,
                model: s.model,
                messages,
                max_tokens: s.max_tokens,
                temperature: 0.3,
                stream: false,
            }),
        });
    }
    catch (fetchErr) {
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError')
            throw fetchErr;
        throw new Error('Network request failed. Make sure the SillyTavern server is running.');
    }
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`${s.provider.toUpperCase()} API ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? '';
}
/**
 * Custom-provider mode — user-supplied Base URL and API key.
 * Normalises the base URL before appending /v1/chat/completions.
 */
export async function callCustomAPI(systemPrompt, userPrompt, s, signal) {
    const { ext_api_key: apiKey, ext_base_url: baseUrl, model, max_tokens } = s;
    if (!baseUrl)
        throw new Error('Custom provider requires a Base URL. Check the settings.');
    if (!apiKey)
        throw new Error('Custom API key is empty. Check the settings.');
    if (!model)
        throw new Error('Model name is empty. Check the settings.');
    // Validate protocol — only http and https are valid for API calls.
    // Catches typos like "htps://" or "ftp://" before attempting a fetch.
    if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error(`Invalid Base URL: "${baseUrl}". Must start with http:// or https://.`);
    }
    // Strip trailing slash and any /v1 or /v1/chat/completions suffix the user may have included,
    // so we never produce .../v1/v1/...
    const normBase = baseUrl.replace(/\/$/, '').replace(/\/v1\/chat\/completions$/i, '').replace(/\/v1$/i, '');
    const url = normBase + '/v1/chat/completions';
    const messages = _buildMessages(systemPrompt, userPrompt);
    let resp;
    try {
        resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            signal: signal ?? undefined,
            body: JSON.stringify({ model, max_tokens, messages, temperature: 0.3, stream: false }),
        });
    }
    catch (fetchErr) {
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError')
            throw fetchErr;
        throw new Error(`Unable to connect to custom API server. Check the Base URL: ${baseUrl}`);
    }
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Custom API error: ${resp.status}: ${text.slice(0, 200)}`);
    }
    return (await resp.json()).choices?.[0]?.message?.content ?? '';
}
