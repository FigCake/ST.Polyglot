// Pronunciation scores from Azure AI Speech (optional: pron_engine 'azure', with
// the learner's own Speech key and region). Written from Microsoft's public
// REST reference for short audio with pronunciation assessment.
//
//   POST https://<region>.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
//        ?language=<it-IT…>&format=detailed
//   Ocp-Apim-Subscription-Key   the key
//   Pronunciation-Assessment    base64 JSON: the sentence to compare with, 0–100 scores, word by word
//   body                        WAV, 16 kHz mono 16-bit (what the browser recorded, converted here)
//   → DisplayText, NBest[0]: PronScore / AccuracyScore / FluencyScore / CompletenessScore and
//     Words[] with AccuracyScore and ErrorType (None, Mispronunciation, Omission, Insertion);
//     newer answers nest the scores under PronunciationAssessment, both are read
//
// The request goes from the browser to Microsoft; the recording is not kept.
import { withTimeout } from './utils.js';
import { PronServiceError } from './pron-error.js';
import { toBase64 } from './user-files.js';
const REGION = /^[a-z0-9]+$/;
const TIMEOUT_MS = 30_000;
/** The key and region when Azure is the chosen pronunciation check and both are filled in; else null. */
export function azureConfig(s) {
    const key = (s.pron_azure_key ?? '').trim();
    const region = (s.pron_azure_region ?? '').trim().toLowerCase();
    return s.pron_engine === 'azure' && key && REGION.test(region) ? { key, region } : null;
}
/** The Pronunciation-Assessment header for a sentence: scores 0–100, word by word, words left out or added counted. */
export function assessmentHeader(reference) {
    return toBase64(JSON.stringify({ ReferenceText: reference, GradingSystem: 'HundredMark', Granularity: 'Word', Dimension: 'Comprehensive', EnableMiscue: true }));
}
const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
/** Azure's answer as an assessment; null when it heard nothing it could score. */
export function parseAssessment(answer) {
    const a = answer;
    const best = a?.NBest?.[0];
    if (!a || a.RecognitionStatus !== 'Success' || !best)
        return null;
    const scores = { ...best, ...best.PronunciationAssessment };
    return {
        text: a.DisplayText ?? best.Display ?? '',
        score: num(scores.PronScore),
        accuracy: num(scores.AccuracyScore),
        fluency: num(scores.FluencyScore),
        completeness: num(scores.CompletenessScore),
        words: (best.Words ?? []).map(w => {
            const ws = { ...w, ...w.PronunciationAssessment };
            return { word: w.Word ?? '', score: num(ws.AccuracyScore), error: ws.ErrorType ?? 'None' };
        }),
    };
}
// ── Audio ─────────────────────────────────────────────────────────────────────
/** Samples (−1…1, one channel) as a 16-bit PCM WAV file. Pure. */
export function encodeWav(samples, rate) {
    const out = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(out.buffer);
    const text = (at, s) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
    return out;
}
const RATE = 16_000;
/** A recording (any format the browser can decode) as the 16 kHz mono WAV Azure takes. */
export async function toWav16k(recording) {
    const ctx = new AudioContext();
    try {
        const decoded = await ctx.decodeAudioData(await recording.arrayBuffer());
        const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start();
        return encodeWav((await offline.startRendering()).getChannelData(0), RATE);
    }
    finally {
        void ctx.close();
    }
}
// ── The request ───────────────────────────────────────────────────────────────
/** Scores a WAV recording of `reference` read in `locale` (it-IT …). Throws PronServiceError. */
export async function assessPronunciation(cfg, wav, reference, locale, signal) {
    const url = `https://${cfg.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`
        + `?language=${encodeURIComponent(locale)}&format=detailed`;
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': cfg.key,
                'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
                'Pronunciation-Assessment': assessmentHeader(reference),
                Accept: 'application/json',
            },
            body: wav,
            signal: withTimeout(signal, TIMEOUT_MS),
        });
    }
    catch (e) {
        if (signal?.aborted)
            throw e;
        throw new PronServiceError('network', String(e.message ?? e));
    }
    if (res.status === 401 || res.status === 403)
        throw new PronServiceError('key', `HTTP ${res.status}`);
    if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 160);
        // An unsupported language answers 400 and says so
        throw new PronServiceError(res.status === 400 && /language|locale/i.test(detail) ? 'language' : 'other', `HTTP ${res.status} ${detail}`.trim());
    }
    const assessment = parseAssessment(await res.json().catch(() => null));
    if (!assessment)
        throw new PronServiceError('nothing');
    return assessment;
}
