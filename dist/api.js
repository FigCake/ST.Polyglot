// AI provider router — complete() entry point and per-provider backends.
//
// No DOM, and getSettings() is never called: complete() takes `s: Settings`,
// and runtime.ts binds the live settings and wraps it in the JSON client
// (ai/client.ts). From ST it only reads request headers, which keys are set,
// the current chat-completion connection and its connection profiles.
//
// completeChat() sends a whole conversation (the web app's own chat); outside
// SillyTavern (HOST.ownKeys) the known providers are called straight from the
// browser with the learner's own keys (own_keys in settings).
import { findProfile, profileSource, sendThroughProfile } from './ai/st-profiles.js';
import { getRequestHeaders, getContext, SECRET_KEYS, secret_state } from './st.js';
import { providerById } from './ai/providers.js';
import { HOST } from './host.js';
// ── Provider config tables ────────────────────────────────────────────────────
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
// ── Request plumbing ──────────────────────────────────────────────────────────
const TEMPERATURE = 0.3;
function buildMessages(system, user) {
    return system
        ? [{ role: 'system', content: system }, { role: 'user', content: user }]
        : [{ role: 'user', content: user }];
}
/** Leading reasoning blocks some models write before the answer; an unclosed one runs to the end. */
const REASONING_BLOCK = /^\s*<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$)/i;
/** The answer without the model's reasoning preamble. */
export function stripReasoning(text) {
    let rest = text;
    for (let m = REASONING_BLOCK.exec(rest); m; m = REASONING_BLOCK.exec(rest))
        rest = rest.slice(m[0].length);
    return rest;
}
/**
 * Text of a content-part list, skipping reasoning parts: Anthropic `thinking`
 * blocks (no `text`), Gemini parts flagged `thought`, any typed non-text part.
 */
function answerParts(parts) {
    if (!Array.isArray(parts))
        return undefined;
    return parts
        .filter(p => typeof p?.text === 'string' && !p.thought && (!p.type || p.type === 'text' || p.type === 'output_text'))
        .map(p => p.text)
        .join('');
}
/** Text of a text-completion answer (a connection profile for a local backend). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textCompletion(data) {
    const text = data?.choices?.[0]?.text ?? data?.results?.[0]?.text ?? data?.response ?? data?.content;
    return typeof text === 'string' ? text : undefined;
}
/** Reads the answer text and the "hit the token limit" flag from any supported response shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readReply(data) {
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    // ST wraps Claude replies as choices[0] with content[0]'s text — '' when that block
    // is thinking — and keeps the original blocks in data.content
    const text = ((typeof content === 'string' ? content : answerParts(content)) || undefined) ?? // OpenAI-compatible
        answerParts(data?.content) ?? // Anthropic
        answerParts(data?.candidates?.[0]?.content?.parts) ?? // Gemini
        textCompletion(data) ??
        '';
    const truncated = choice?.finish_reason === 'length' ||
        data?.stop_reason === 'max_tokens' ||
        data?.candidates?.[0]?.finishReason === 'MAX_TOKENS' ||
        data?.results?.[0]?.finish_reason === 'length' || // KoboldCpp
        data?.done_reason === 'length' || // Ollama
        data?.stopped_limit === true; // llama.cpp
    return { text: stripReasoning(text), truncated };
}
/** Long enough for slow reasoning models; a hung backend must not leave a spinner forever. */
const REQUEST_TIMEOUT_MS = 180_000;
/** The caller's signal plus a timeout; `release` clears the timer and the listener on the caller's signal. */
function timeoutSignal(caller) {
    const ctrl = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    const forward = () => ctrl.abort();
    if (caller?.aborted)
        ctrl.abort();
    else
        caller?.addEventListener('abort', forward, { once: true });
    return {
        signal: ctrl.signal,
        timedOut: () => expired,
        release: () => { clearTimeout(timer); caller?.removeEventListener('abort', forward); },
    };
}
async function postChat({ url, headers, body, signal, errorLabel, networkHint }) {
    const request = timeoutSignal(signal);
    try {
        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                signal: request.signal,
                body: JSON.stringify({ temperature: TEMPERATURE, stream: false, ...body }),
            });
        }
        catch (e) {
            if (request.timedOut())
                throw new Error(`${errorLabel}: no response within ${REQUEST_TIMEOUT_MS / 1000} s.`, { cause: e });
            if (e instanceof Error && e.name === 'AbortError')
                throw e;
            throw new Error(networkHint, { cause: e });
        }
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(`${errorLabel} ${resp.status}: ${detail.slice(0, 200)}`);
        }
        const data = await resp.json();
        // ST passes some upstream failures (bad key, quota, a blocked prompt) as 200 + { error }
        if (data?.error) {
            const message = typeof data.error === 'object' ? data.error.message : data.error;
            throw new Error(`${errorLabel}: ${typeof message === 'string' && message ? message : 'the provider returned an error'}`);
        }
        return readReply(data);
    }
    finally {
        request.release();
    }
}
const ST_GENERATE_URL = '/api/backends/chat-completions/generate';
/** Sources whose requests ST sends through its reverse proxy when one is set (as ST's own client does). */
const PROXY_SOURCES = new Set(['claude', 'openai', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'zai', 'moonshot']);
/**
 * What ST's own client adds to a request for this source and model, which its
 * backend relies on: OpenAI reasoning models (o1/o3/o4, gpt-5+) take
 * max_completion_tokens and no temperature; Claude gets reasoning_effort
 * 'auto', which keeps ST from turning on extended thinking (slow, and
 * Polyglot only needs the answer).
 */
function sourceFields(source, model, maxTokens) {
    const reasoningModel = /^(openai\/)?(o1|o3|o4)/.test(model) || /gpt-[5-9]/.test(model);
    if (['openai', 'openrouter', 'azure_openai'].includes(source) && reasoningModel) {
        return { max_tokens: undefined, max_completion_tokens: maxTokens, temperature: undefined };
    }
    if (source === 'claude')
        return { reasoning_effort: 'auto' };
    return {};
}
/** The parts of ST's connection settings its backend needs to reach the endpoint: Custom URL, reverse proxy. */
function connectionFields(source, ccs) {
    const fields = {};
    if (source === 'custom') {
        const params = (v) => getContext().substituteParams?.(String(v ?? '')) ?? String(v ?? '');
        Object.assign(fields, {
            custom_url: ccs.custom_url ?? '',
            custom_include_body: params(ccs.custom_include_body),
            custom_exclude_body: params(ccs.custom_exclude_body),
            custom_include_headers: params(ccs.custom_include_headers),
        });
    }
    if (ccs.reverse_proxy && PROXY_SOURCES.has(source)) {
        Object.assign(fields, { reverse_proxy: ccs.reverse_proxy, proxy_password: ccs.proxy_password ?? '' });
    }
    return fields;
}
const ST_NETWORK_HINT = 'Network request failed. Make sure the SillyTavern server is running.';
// ── Public API ────────────────────────────────────────────────────────────────
/** Sends one system + user prompt to the provider chosen in settings (runtime.ts binds `s`). */
export function complete(s, system, user, signal = null) {
    return completeChat(s, buildMessages(system, user), signal);
}
/**
 * Sends a whole conversation to the provider chosen in settings; `options.temperature`
 * replaces Polyglot's own low one (a character's replies want more variety).
 */
export function completeChat(s, messages, signal = null, options = {}) {
    const extra = options.temperature === undefined ? {} : { temperature: options.temperature };
    // Outside SillyTavern its own connection, profiles and Vertex do not exist
    const provider = !HOST.stConnection && ['st', 'profile', 'vertexai'].includes(s.provider || 'st') ? 'custom' : s.provider || 'st';
    switch (provider) {
        case 'host': return HOST.ai
            ? HOST.ai.complete(s.host_connection, messages, { temperature: options.temperature ?? TEMPERATURE, maxTokens: s.max_tokens }, signal)
            : completeViaCustom(messages, s, signal, extra);
        case 'st': return completeViaST(messages, s, signal, extra);
        case 'custom': return completeViaCustom(messages, s, signal, extra);
        case 'profile': return completeViaProfile(messages, s, signal, extra);
        // ST reads its own saved Vertex auth (Express key or service account)
        case 'vertexai': return completeViaST(messages, { ...s, route_chat_source: 'vertexai', route_model: s.model }, signal, extra);
        default: return HOST.ownKeys ? completeDirect(messages, s, signal, extra) : completeViaProvider(messages, s, signal, extra);
    }
}
/** ST's current connection (or the source/model overridden in route_* settings). */
async function completeViaST(messages, s, signal, extra = {}) {
    const ccs = getContext().chatCompletionSettings ?? {};
    const source = s.route_chat_source || ccs.chat_completion_source || 'openai';
    const modelKey = ROUTE_MODEL_KEY.get(source) || 'model';
    const stModel = ccs[modelKey];
    const model = s.route_model || (typeof stModel === 'string' ? stModel : '');
    return postChat({
        url: ST_GENERATE_URL,
        headers: getRequestHeaders(),
        signal,
        errorLabel: 'ST API',
        networkHint: ST_NETWORK_HINT,
        body: {
            chat_completion_source: source,
            [modelKey]: model,
            model,
            messages: messages,
            max_tokens: s.max_tokens,
            // Only when this is ST's own connection: its URL and proxy belong to it
            ...(!s.route_chat_source || s.route_chat_source === ccs.chat_completion_source ? connectionFields(source, ccs) : {}),
            ...sourceFields(source, model, s.max_tokens),
            ...extra,
            ...(source === 'vertexai' && {
                vertexai_auth_mode: ccs.vertexai_auth_mode ?? 'full',
                vertexai_region: ccs.vertexai_region ?? 'global',
                vertexai_express_project_id: ccs.vertexai_express_project_id ?? '',
            }),
        },
    });
}
/** A known provider routed through ST's backend, reusing ST's stored API keys. */
async function completeViaProvider(messages, s, signal, extra = {}) {
    const provider = providerById(s.provider);
    if (!provider)
        throw new Error(`Unknown provider: ${s.provider}`);
    const source = provider.source;
    if (!s.model)
        throw new Error('No model selected. Please choose a model in the settings.');
    const secretKey = provider.secret && SECRET_KEYS[provider.secret];
    if (secretKey && !secret_state[secretKey]) {
        throw new Error(`${s.provider.toUpperCase()} API key is not set. Enter it in SillyTavern's API settings.`);
    }
    return postChat({
        url: ST_GENERATE_URL,
        headers: getRequestHeaders(),
        signal,
        errorLabel: `${s.provider.toUpperCase()} API`,
        networkHint: ST_NETWORK_HINT,
        body: {
            chat_completion_source: source, model: s.model, messages, max_tokens: s.max_tokens,
            ...sourceFields(source, s.model, s.max_tokens),
            ...extra,
        },
    });
}
/**
 * A SillyTavern connection profile: its API, model, key and proxy, without
 * its preset. ST checks the key and reads the answer's errors.
 */
async function completeViaProfile(messages, s, signal, extra = {}) {
    if (!s.profile_id)
        throw new Error('No connection profile chosen. Choose one in Polyglot\'s settings.');
    const profile = findProfile(s.profile_id);
    if (!profile)
        throw new Error('The connection profile chosen in Polyglot\'s settings no longer exists. Choose another one.');
    const source = profileSource(profile);
    const request = timeoutSignal(signal);
    try {
        const data = await sendThroughProfile(profile.id, messages, s.max_tokens, request.signal, {
            temperature: TEMPERATURE,
            ...(source && sourceFields(source, profile.model ?? '', s.max_tokens)),
            ...extra,
        });
        return readReply(data);
    }
    catch (e) {
        if (request.timedOut())
            throw new Error(`Connection profile: no response within ${REQUEST_TIMEOUT_MS / 1000} s.`, { cause: e });
        if (e instanceof Error && e.name === 'AbortError')
            throw e;
        if (e instanceof TypeError && /fetch|network/i.test(e.message))
            throw new Error(ST_NETWORK_HINT, { cause: e });
        throw new Error(`Connection profile "${profile.name || profile.id}": ${e?.message || 'the request failed'}`, { cause: e });
    }
    finally {
        request.release();
    }
}
/** Any OpenAI-compatible endpoint with a user-supplied base URL and key. */
async function completeViaCustom(messages, s, signal, extra = {}) {
    const { ext_api_key: apiKey, ext_base_url: baseUrl, model, max_tokens } = s;
    if (!baseUrl)
        throw new Error('Custom provider requires a Base URL. Check the settings.');
    if (!apiKey)
        throw new Error('Custom API key is empty. Check the settings.');
    if (!model)
        throw new Error('Model name is empty. Check the settings.');
    if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error(`Invalid Base URL: "${baseUrl}". Must start with http:// or https://.`);
    }
    // Accept ".../v1" or ".../v1/chat/completions" without producing ".../v1/v1/..."
    const root = baseUrl.replace(/\/$/, '').replace(/\/v1\/chat\/completions$/i, '').replace(/\/v1$/i, '');
    return postChat({
        url: `${root}/v1/chat/completions`,
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
        errorLabel: 'Custom API error:',
        networkHint: `Unable to connect to custom API server. Check the Base URL: ${baseUrl}`,
        body: { model, max_tokens, messages, ...extra },
    });
}
// ── Straight from the browser (outside SillyTavern) ───────────────────────────
/** The known providers' endpoints for requests from the browser: all OpenAI-compatible except Claude. */
const DIRECT_URL = {
    openai: 'https://api.openai.com/v1/chat/completions',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/v1/chat/completions',
    claude: 'https://api.anthropic.com/v1/messages',
};
/** A known provider called from the browser with the learner's own key (own_keys). */
async function completeDirect(messages, s, signal, extra = {}) {
    const provider = providerById(s.provider);
    const url = DIRECT_URL[s.provider];
    if (!provider || !url)
        throw new Error(`Unknown provider: ${s.provider}`);
    if (!s.model)
        throw new Error('No model selected. Please choose a model in the settings.');
    const key = (s.own_keys ?? {})[s.provider]?.trim();
    if (!key)
        throw new Error(`${provider.label} API key is not set. Enter it in Polyglot's settings.`);
    const common = { signal, errorLabel: `${provider.label} API`, networkHint: `Unable to reach ${provider.label}. Check your connection and the API key.` };
    if (s.provider === 'claude') {
        // Anthropic's own format: the system prompt apart, and a header allowing browser requests
        const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
        return postChat({
            ...common, url,
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
            body: { model: s.model, max_tokens: s.max_tokens, ...(system && { system }), messages: messages.filter(m => m.role !== 'system'), stream: undefined, ...extra },
        });
    }
    return postChat({
        ...common, url,
        headers: { Authorization: `Bearer ${key}` },
        body: { model: s.model, max_tokens: s.max_tokens, messages, ...sourceFields(provider.source, s.model, s.max_tokens), ...extra },
    });
}
