// Reading aloud with a voice service.
//
//   direct    ElevenLabs · Google Cloud Text-to-Speech · an OpenAI-compatible
//             /audio/speech endpoint (OpenAI, or a local server) · Fish Audio
//             ─▶ MP3 bytes ─▶ played, kept for the session, and (setting
//             voice_save) stored as the word's or its example's sound file, so a
//             word is paid for once and its sound reaches flashcards and exports
//             OpenAI's comes through the voice settings' one OpenAI connection
//             (openai-speech.ts): in SillyTavern by default its saved key, through its server
//   host      the app's own voice service (Marinara's Text to Speech, HOST.ai):
//             its sound comes back, so it is kept like a direct service's
//   st        ST's own TTS extension through its /speak command (the voice
//             service set up in ST; nothing comes back to keep)
//   browser   the Web Speech API (speech.ts), also the fallback for both
//
// Requests are written from each service's public API reference with
// Polyglot's own code. They go from the browser; voice_proxy sends them through
// ST's CORS proxy instead (enableCorsProxy in config.yaml) for a service that
// does not answer browsers.
import { withTimeout } from './utils.js';
import { HOST } from './host.js';
import { openAiRoute, OPENAI_URL } from './openai-speech.js';
/** Services Polyglot calls itself (their sound can be kept). */
export const DIRECT_PROVIDERS = ['host', 'elevenlabs', 'google', 'openai', 'fish'];
/** A voice request (answer included) gives up after this long. */
const VOICE_TIMEOUT_MS = 60_000;
export const DEFAULTS = {
    elevenlabsModel: 'eleven_multilingual_v2',
    openaiUrl: 'https://api.openai.com/v1',
    openaiModel: 'gpt-4o-mini-tts',
    openaiVoice: 'alloy',
    fishModel: 's2-pro',
};
/** Reading speeds offered (setting voice_speed): slow, a little slow, normal. */
export const VOICE_SPEEDS = ['0.75', '0.9', '1'];
export const DEFAULT_VOICE_SPEED = '0.9';
/** The settings of the chosen service. */
export function ttsConfig(s) {
    const provider = s.voice_provider ?? 'browser';
    const speed = Number(VOICE_SPEEDS.includes(s.voice_speed ?? '') ? s.voice_speed : DEFAULT_VOICE_SPEED);
    const pick = (key, voice, model, baseUrl) => ({
        provider, key: (key ?? '').trim(), voice: (voice ?? '').trim(), model: (model ?? '').trim(),
        baseUrl: (baseUrl ?? '').trim(), speed, proxy: !!s.voice_proxy,
    });
    switch (provider) {
        case 'elevenlabs': return pick(s.voice_el_key, s.voice_el_voice, s.voice_el_model);
        case 'google': return pick(s.voice_gg_key, s.voice_gg_voice);
        case 'openai': {
            // The voice settings' one OpenAI connection (openai-speech.ts): SillyTavern's saved key, or a key and address
            const route = openAiRoute(s);
            if (route?.via === 'st')
                return { ...pick('', s.voice_oa_voice, s.voice_oa_model), viaSt: true };
            return route ? pick(route.key, s.voice_oa_voice, s.voice_oa_model, route.url === OPENAI_URL ? '' : route.url)
                : pick('', s.voice_oa_voice, s.voice_oa_model, s.voice_oa_url);
        }
        case 'fish': return pick(s.voice_fish_key, s.voice_fish_voice, s.voice_fish_model);
        case 'host': return pick('', s.voice_host_voice);
        default: return pick('', s.voice_st_voice);
    }
}
/**
 * What a direct service still needs before it can speak ('' when ready):
 * a key (an OpenAI-compatible local server may need none), and an
 * ElevenLabs voice id (it has no default voice).
 */
export function missingFor(c) {
    if (!DIRECT_PROVIDERS.includes(c.provider) || c.provider === 'host' || c.viaSt)
        return '';
    const custom = c.provider === 'openai' && c.baseUrl && !c.baseUrl.startsWith(DEFAULTS.openaiUrl);
    if (!c.key && !custom)
        return 'key';
    if (c.provider === 'elevenlabs' && !c.voice)
        return 'voice';
    return '';
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
/** The language of a code, without its region: "en-GB" → "en"; Google lists Mandarin and Cantonese as cmn / yue. */
const baseLang = (code) => {
    const lang = code.split('-')[0].toLowerCase();
    return lang === 'cmn' || lang === 'yue' ? 'zh' : lang;
};
/** A Google voice name ("it-IT-Neural2-A") starts with its language code. */
const googleLang = (voice) => /^[a-z]{2,3}-[A-Z]{2}/.exec(voice)?.[0];
/** The HTTP request that reads `text` (language `langCode`, e.g. "it-IT") with the configured voice. */
export function ttsRequest(c, text, langCode) {
    const json = (body) => JSON.stringify(body);
    switch (c.provider) {
        case 'elevenlabs':
            return {
                url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(c.voice)}?output_format=mp3_44100_128`,
                headers: { 'xi-api-key': c.key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
                body: json({
                    text, model_id: c.model || DEFAULTS.elevenlabsModel,
                    voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: clamp(c.speed, 0.7, 1.2) },
                }),
                json: false,
            };
        case 'google': {
            // A chosen voice reads its own language: a word of another (known) language gets that language's default voice
            const voice = c.voice && (!langCode || baseLang(googleLang(c.voice) ?? '') === baseLang(langCode)) ? c.voice : '';
            return {
                url: 'https://texttospeech.googleapis.com/v1/text:synthesize',
                headers: { 'X-Goog-Api-Key': c.key, 'Content-Type': 'application/json' },
                body: json({
                    input: { text },
                    voice: { languageCode: (voice && googleLang(voice)) || langCode || 'en-US', ...(voice && { name: voice }) },
                    audioConfig: { audioEncoding: 'MP3', speakingRate: clamp(c.speed, 0.25, 4) },
                }),
                json: true,
            };
        }
        case 'openai':
            return {
                url: `${(c.baseUrl || DEFAULTS.openaiUrl).replace(/\/+$/, '')}/audio/speech`,
                headers: { 'Content-Type': 'application/json', ...(c.key && { Authorization: `Bearer ${c.key}` }) },
                body: json({
                    model: c.model || DEFAULTS.openaiModel, input: text, voice: c.voice || DEFAULTS.openaiVoice,
                    speed: clamp(c.speed, 0.25, 4), response_format: 'mp3',
                }),
                json: false,
            };
        case 'fish':
            return {
                url: 'https://api.fish.audio/v1/tts',
                headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json', model: c.model || DEFAULTS.fishModel },
                body: json({
                    text, ...(c.voice && { reference_id: c.voice }), format: 'mp3', mp3_bitrate: 128,
                    prosody: { speed: clamp(c.speed, 0.5, 2), volume: 0 },
                }),
                json: false,
            };
        default:
            throw new Error(`not a direct voice service: ${c.provider}`);
    }
}
/** Fingerprint of what a request would say and how: the same text and voice play from the cache. */
export function cacheKey(c, text, langCode) {
    return [c.provider, c.voice, c.model, c.baseUrl, c.speed, langCode, text].join('\u0001');
}
// ── Errors ────────────────────────────────────────────────────────────────────
export class TtsError extends Error {
    network;
    /** No answer reached the page: often a service that does not accept browsers (try the ST proxy). */
    constructor(message, network = false) {
        super(message);
        this.network = network;
    }
}
/** A service's error answer, in a line. */
async function errorText(res) {
    const raw = await res.text().catch(() => '');
    try {
        const v = JSON.parse(raw);
        const pick = (x) => (typeof x === 'string' ? x : x?.message);
        return (pick(v.error) ?? pick(v.detail) ?? v.message ?? raw).slice(0, 200);
    }
    catch {
        return raw.slice(0, 200);
    }
}
const fromBase64 = (b64) => Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
/**
 * Sends a request to a service, through ST's CORS proxy when asked (it needs
 * ST's headers, and drops the query string). A request that never got an
 * answer is a network error; one answered with an error status says why.
 */
async function ttsFetch(c, url, init, stHeaders) {
    let res;
    // Also bounds reading the answer: a server that never finishes must not hold 🔊 (or a run) forever
    const signal = withTimeout(init.signal, VOICE_TIMEOUT_MS);
    try {
        res = await fetch(c.proxy ? `/proxy/${url}` : url, { ...init, signal, headers: c.proxy ? { ...stHeaders, ...init.headers } : init.headers });
    }
    catch (e) {
        if (init.signal?.aborted)
            throw e;
        if (signal.aborted)
            throw new TtsError(`no answer within ${VOICE_TIMEOUT_MS / 1000} s`);
        throw new TtsError(String(e.message ?? e), true);
    }
    if (!res.ok)
        throw new TtsError(`${res.status} ${await errorText(res)}`.trim());
    return res;
}
/** Answers that are not sound: an error or a web page sent with status 200 (a local server, a captive portal). */
const NOT_SOUND = /json|html|text\//i;
const startsWith = (b, at, ascii) => [...ascii].every((ch, i) => b[at + i] === ch.charCodeAt(0));
/**
 * A sound's format from its first bytes, as a file extension; null when the
 * bytes are not a sound. A service may answer another format than asked
 * (a local server sending WAV): the file is named for what it holds, which is
 * what Anki's phone apps go by.
 */
export function soundFormat(b) {
    if (startsWith(b, 0, 'ID3'))
        return 'mp3';
    if (startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WAVE'))
        return 'wav';
    if (startsWith(b, 0, 'OggS'))
        return startsWith(b, 28, 'OpusHead') ? 'opus' : 'ogg';
    if (startsWith(b, 0, 'fLaC'))
        return 'flac';
    if (startsWith(b, 4, 'ftyp'))
        return 'm4a';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
        return 'webm';
    // Frame sync: ADTS AAC has layer bits 00, MPEG audio (MP3) does not
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
        return (b[1] & 0x06) === 0 ? 'aac' : 'mp3';
    return null;
}
/**
 * Reads `text` with the configured direct service; returns MP3 bytes.
 * `stHeaders` are ST's request headers (CSRF), needed for its CORS proxy.
 */
export async function synthesize(c, text, langCode, stHeaders = {}, signal) {
    if (c.provider === 'host') {
        if (!HOST.ai)
            throw new TtsError('no voice service here');
        const bytes = await HOST.ai.speak(text, c.voice, withTimeout(signal, VOICE_TIMEOUT_MS));
        if (!soundFormat(bytes))
            throw new TtsError('not a sound');
        return bytes;
    }
    if (c.viaSt) {
        // SillyTavern's own OpenAI voice route, with its saved key
        const res = await ttsFetch({ ...c, proxy: false }, '/api/openai/generate-voice', {
            method: 'POST', signal, headers: { ...stHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: c.voice || DEFAULTS.openaiVoice, model: c.model || DEFAULTS.openaiModel, speed: clamp(c.speed, 0.25, 4) }),
        }, stHeaders);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!soundFormat(bytes))
            throw new TtsError('not a sound');
        return bytes;
    }
    const req = ttsRequest(c, text, langCode);
    const res = await ttsFetch(c, req.url, { method: 'POST', headers: req.headers, body: req.body, signal }, stHeaders);
    if (req.json) {
        const data = await res.json().catch(() => null);
        if (!data?.audioContent)
            throw new TtsError('no audio in the answer');
        return fromBase64(data.audioContent);
    }
    const type = res.headers.get('content-type') ?? '';
    if (NOT_SOUND.test(type))
        throw new TtsError(`not a sound (${type.split(';')[0]}): ${(await errorText(res)).slice(0, 120)}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length)
        throw new TtsError('empty answer');
    // Without a sound type (ST's proxy passes none) the bytes must look like one
    if (!/^audio\//i.test(type) && !soundFormat(bytes)) {
        throw new TtsError(`not a sound: ${new TextDecoder().decode(bytes.slice(0, 120))}`);
    }
    return bytes;
}
// ── Voice lists ───────────────────────────────────────────────────────────────
/** Voices a service offers (id and a label), for the voice picker; [] when it has no list to fetch. */
export async function listVoices(c, langCode, stHeaders = {}) {
    if (c.provider === 'host')
        return HOST.ai?.voices() ?? [];
    const get = async (url, headers) => (await ttsFetch(c, url, { headers }, stHeaders)).json();
    if (c.provider === 'elevenlabs') {
        const data = await get('https://api.elevenlabs.io/v1/voices', { 'xi-api-key': c.key });
        return (data.voices ?? []).map(v => ({ id: v.voice_id, label: v.name }));
    }
    if (c.provider === 'google') {
        const data = await get(`https://texttospeech.googleapis.com/v1/voices${langCode ? `?languageCode=${encodeURIComponent(langCode)}` : ''}`, { 'X-Goog-Api-Key': c.key });
        // Filtered here too, by language (through ST's proxy the languageCode filter is lost)
        return (data.voices ?? [])
            .filter(v => !langCode || !v.languageCodes || v.languageCodes.some(code => baseLang(code) === baseLang(langCode)))
            .map(v => ({ id: v.name, label: `${v.name}${v.ssmlGender ? ` (${v.ssmlGender.toLowerCase()})` : ''}` }));
    }
    return [];
}
