// OpenAI for voice — reading aloud (tts.ts), transcription and pronunciation
// advice — through one connection, set once in the voice settings. Written
// from OpenAI's public API reference.
//
//   the connection   a key entered once (and an address, for another OpenAI-compatible API);
//                    left empty, SillyTavern's saved OpenAI key — its server sends the request
//                    (/api/openai/generate-voice, /transcribe-audio, the chat route), so the key
//                    never reaches the browser — or, in the web app and Marinara, the AI
//                    connection's OpenAI key
//   transcribe       POST <url>/audio/transcriptions   file, model, language → { text }: compared
//                    with the target like the browser's recognition (speech.ts). The target is
//                    not sent as a prompt: it would pull the transcript toward it and hide mistakes.
//   advise           POST <url>/chat/completions       an audio model hears the recording (WAV) and
//                    the target, and answers a few tips in words — no score, since a model's
//                    numbers change from one asking to the next
//
// The recording is not kept.
import { withTimeout } from './utils.js';
import { PronServiceError } from './pron-error.js';
import { HOST } from './host.js';
import { getRequestHeaders, secret_state, SECRET_KEYS } from './st.js';
import { toWav16k } from './azure-pron.js';
import { toBase64 } from './user-files.js';
export const OPENAI_URL = 'https://api.openai.com/v1';
export const STT_MODEL = 'gpt-4o-mini-transcribe';
export const ADVICE_MODEL = 'gpt-audio';
const TIMEOUT_MS = 60_000;
/**
 * The voice settings' OpenAI connection, or null when there is none: the key
 * entered for voice; else another address as it is (a local server may need
 * no key); else SillyTavern's saved key when it has one, or the AI
 * connection's OpenAI key.
 */
export function openAiRoute(s) {
    const url = ((s.voice_oa_url ?? '').trim() || OPENAI_URL).replace(/\/+$/, '');
    const key = (s.voice_oa_key ?? '').trim();
    if (key || url !== OPENAI_URL)
        return { via: 'direct', url, key };
    if (HOST.stConnection)
        return secret_state[SECRET_KEYS.OPENAI] ? { via: 'st' } : null;
    const chatKey = (s.own_keys?.openai ?? '').trim();
    return chatKey ? { via: 'direct', url, key: chatKey } : null;
}
/** The connection with the models for transcription and advice. */
export function openAiSpeechConfig(s) {
    const route = openAiRoute(s);
    return route && { route, sttModel: (s.pron_stt_model ?? '').trim() || STT_MODEL, adviceModel: (s.pron_advice_model ?? '').trim() || ADVICE_MODEL };
}
/** The transcription check: chosen, and set up. */
export const transcriptionConfig = (s) => (s.pron_engine === 'openai' ? openAiSpeechConfig(s) : null);
/** The advice button: switched on, and set up. */
export const adviceConfig = (s) => (s.pron_advice ? openAiSpeechConfig(s) : null);
/** Sends a request and reads the JSON answer, with failures as PronServiceError. */
async function send(url, init, signal) {
    let res;
    try {
        res = await fetch(url, { ...init, method: 'POST', signal: withTimeout(signal, TIMEOUT_MS) });
    }
    catch (e) {
        if (signal?.aborted)
            throw e;
        throw new PronServiceError('network', String(e.message ?? e));
    }
    if (res.status === 401 || res.status === 403)
        throw new PronServiceError('key', `HTTP ${res.status}`);
    const text = await res.text().catch(() => '');
    let body = null;
    try {
        body = JSON.parse(text);
    }
    catch { /* an error page */ }
    if (!res.ok) {
        const message = body?.error?.message ?? text;
        // SillyTavern without a saved OpenAI key answers 400 with nothing to say
        if (res.status === 400 && !text.trim())
            throw new PronServiceError('key', 'no key saved');
        throw new PronServiceError('other', `HTTP ${res.status} ${message}`.trim().slice(0, 200));
    }
    return body;
}
const direct = (route, path) => ({
    url: `${route.url}${path}`,
    headers: route.key ? { Authorization: `Bearer ${route.key}` } : {},
});
/** The file name the recording is sent under: its format decides how the API reads it. */
export function recordingName(type) {
    const ext = /ogg/.test(type) ? 'ogg' : /mp4|aac|m4a/.test(type) ? 'm4a' : /wav/.test(type) ? 'wav' : /mpeg|mp3/.test(type) ? 'mp3' : 'webm';
    return `speech.${ext}`;
}
/** What was said in a recording; `langCode` (it-IT …) helps, '' lets the model tell. Throws PronServiceError. */
export async function transcribe(cfg, recording, langCode, signal) {
    const form = new FormData();
    let answer;
    if (cfg.route.via === 'st') {
        // ST's route takes the file as "avatar" and passes it on as WAV
        form.append('avatar', new Blob([await toWav16k(recording)], { type: 'audio/wav' }), 'speech.wav');
        form.append('model', cfg.sttModel);
        if (langCode)
            form.append('language', langCode.split('-')[0]);
        const headers = { ...getRequestHeaders() };
        delete headers['Content-Type'];
        answer = await send('/api/openai/transcribe-audio', { headers, body: form }, signal);
    }
    else {
        form.append('file', recording, recordingName(recording.type));
        form.append('model', cfg.sttModel);
        if (langCode)
            form.append('language', langCode.split('-')[0]);
        form.append('response_format', 'json');
        const to = direct(cfg.route, '/audio/transcriptions');
        answer = await send(to.url, { headers: to.headers, body: form }, signal);
    }
    const text = answer?.text?.trim() ?? '';
    if (!text)
        throw new PronServiceError('nothing');
    return text;
}
/** The request for advice on a recording of `target` (a word or sentence in `studyLang`), tips written in `nativeLang`. Pure. */
export function adviceRequest(model, wavBase64, target, studyLang, nativeLang) {
    return {
        model,
        modalities: ['text'],
        max_tokens: 400,
        messages: [
            {
                role: 'system',
                content: `You coach pronunciation for someone learning ${studyLang}. You will hear them read a text aloud. `
                    + 'Give at most three short, concrete tips about the sounds, stress or rhythm that differ from how a native speaker would say it, '
                    + 'naming the word each tip is about. If it already sounds natural, say so in one sentence. '
                    + `Give no score or number. Write in ${nativeLang}, plainly, without headings.`,
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `The text they read: "${target}"` },
                    { type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } },
                ],
            },
        ],
    };
}
/** Tips in words on a WAV recording of `target`. Throws PronServiceError. */
export async function advise(cfg, wav, target, studyLang, nativeLang, signal) {
    const body = adviceRequest(cfg.adviceModel, toBase64(wav), target, studyLang, nativeLang);
    let answer;
    if (cfg.route.via === 'st') {
        // ST's chat route passes the request to OpenAI with its key; it turns a data: audio_url into input_audio
        const messages = body.messages.map(m => ({
            ...m,
            content: Array.isArray(m.content) ? m.content.map((p) => p.type === 'input_audio' ? { type: 'audio_url', audio_url: { url: `data:audio/wav;base64,${p.input_audio?.data}` } } : p) : m.content,
        }));
        answer = await send('/api/backends/chat-completions/generate', {
            headers: getRequestHeaders(),
            body: JSON.stringify({ chat_completion_source: 'openai', model: cfg.adviceModel, messages, max_tokens: body.max_tokens, stream: false }),
        }, signal);
    }
    else {
        const to = direct(cfg.route, '/chat/completions');
        answer = await send(to.url, { headers: { ...to.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal);
    }
    const content = answer?.choices?.[0]?.message?.content;
    const text = (typeof content === 'string' ? content : (content ?? []).map(p => p.text ?? '').join('')).trim();
    if (!text)
        throw new PronServiceError('other', 'empty answer');
    return text;
}
