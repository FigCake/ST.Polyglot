// Records one thing said into the microphone (pronunciation checks, spoken
// exam answers; the browser's own recognition needs no recording).
//
// Recording ends by itself a moment after the speaker falls silent, at the
// latest after maxMs; stop() ends it at once. Nothing said within waitMs
// counts as nothing: the result is null. A monologue (silenceMs: Infinity)
// goes on through pauses until stop() or maxMs.
const MAX_MS = 15_000;
const WAIT_MS = 8_000;
const SILENCE_MS = 1_200;
/** Loudness (RMS of −1…1 samples) above which the speaker counts as speaking. */
const VOICE_LEVEL = 0.02;
const TICK_MS = 100;
export function canRecord() {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}
/** Starts recording; rejects when the microphone is refused or missing. */
export async function startRecording({ maxMs = MAX_MS, waitMs = WAIT_MS, silenceMs = SILENCE_MS } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    let recorder, ctx, analyser;
    try {
        recorder = new MediaRecorder(stream);
        // Loudness, to end after the speaker stops
        ctx = new AudioContext();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        ctx.createMediaStreamSource(stream).connect(analyser);
    }
    catch (e) {
        // The browser could not record after all: the microphone must not stay on
        stream.getTracks().forEach(track => track.stop());
        void ctx?.close();
        throw e;
    }
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size)
        chunks.push(e.data); };
    const frame = new Float32Array(analyser.fftSize);
    const level = () => {
        analyser.getFloatTimeDomainData(frame);
        return Math.sqrt(frame.reduce((sum, v) => sum + v * v, 0) / frame.length);
    };
    let spoke = false, quietSince = 0, discard = false;
    const started = Date.now();
    const done = new Promise(resolve => {
        recorder.onstop = () => {
            clearInterval(timer);
            stream.getTracks().forEach(track => track.stop());
            void ctx?.close();
            resolve(discard || !spoke || !chunks.length ? null : new Blob(chunks, { type: recorder.mimeType }));
        };
    });
    const end = () => { if (recorder.state !== 'inactive')
        recorder.stop(); };
    const timer = setInterval(() => {
        const now = Date.now();
        if (level() > VOICE_LEVEL) {
            spoke = true;
            quietSince = 0;
        }
        else if (spoke)
            quietSince ||= now;
        if ((spoke && quietSince && now - quietSince > silenceMs) || now - started > maxMs || (!spoke && now - started > waitMs))
            end();
    }, TICK_MS);
    try {
        recorder.start();
    }
    catch (e) {
        clearInterval(timer);
        stream.getTracks().forEach(track => track.stop());
        void ctx?.close();
        throw e;
    }
    return {
        // A tap means the speaker has finished, even if the loudness never crossed the bar
        stop: () => { spoke = true; end(); },
        abort: () => { discard = true; end(); },
        done,
        started,
    };
}
