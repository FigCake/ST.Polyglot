// Playback and pronunciation checks: the browser's recognition (Web Speech
// API), or a recording sent to Azure for scores (azure-pron.ts) or to an
// OpenAI-compatible transcription (openai-speech.ts), with optional advice.
//
// The building blocks voice.ts reads aloud with: playing a sound file, the
// browser's voice, and stopping both. Which voice reads a word is voice.ts's.
//
// Design rules:
//   • Pure scoring helpers (speechLangCode, normalizeForPronunciation,
//     pronunciationScore) have no DOM access and are unit-tested.
//   • Only one recognition session is tracked at a time so closing the panel
//     can stop the microphone (abortActiveRecognition).
import { similarityScore } from './utils.js';
import { missedWords, scoredWords } from './missed-words.js';
import { assessPronunciation, toWav16k } from './azure-pron.js';
import { transcribe, advise } from './openai-speech.js';
import { PronServiceError } from './pron-error.js';
import { startRecording, canRecord } from './mic-record.js';
import { recordProblem } from './diagnostics.js';
import { notify } from './ui.manager.js';
import { html, setHtml } from './html.js';
import { t } from './i18n.js';
// ── Language codes ────────────────────────────────────────────────────────────
const LANG_CODES = [
    [['spanish', 'español'], 'es-ES'],
    [['italian', 'italiano'], 'it-IT'],
    [['french', 'français'], 'fr-FR'],
    [['german', 'deutsch'], 'de-DE'],
    [['japanese', '日本語'], 'ja-JP'],
    [['chinese', '中文'], 'zh-CN'],
    [['korean', '한국어'], 'ko-KR'],
    [['portuguese'], 'pt-PT'],
];
/**
 * The BCP-47 code of a language Polyglot knows ("Japanese", "Español" → ja-JP,
 * es-ES); null for one it does not (a custom study language such as Russian).
 */
export function knownLangCode(lang) {
    const l = lang.toLowerCase();
    if (l.includes('english'))
        return 'en-US';
    return LANG_CODES.find(([needles]) => needles.some(n => l.includes(n)))?.[1] ?? null;
}
/** Maps a free-text language name to a BCP-47 code, English for one it does not know. */
export const speechLangCode = (lang) => knownLangCode(lang) ?? 'en-US';
// ── Text-to-speech ────────────────────────────────────────────────────────────
/** Learner-friendly speaking rate. */
const SPEECH_RATE = 0.85;
/**
 * Longest an utterance may last. Chromium stops an utterance after about
 * 15 seconds, so long text is spoken as a queue of shorter pieces.
 */
const MAX_UTTERANCE_SECONDS = 12;
/** Characters spoken per second at rate 1 — kana and hanzi carry more sound per character. */
const CHARS_PER_SECOND = [['ja', 8], ['zh', 8], ['ko', 10]];
const DEFAULT_CHARS_PER_SECOND = 15;
/** Characters that fit in one utterance for a BCP-47 language code. */
export function maxUtteranceChars(code, rate = SPEECH_RATE) {
    const cps = CHARS_PER_SECOND.find(([p]) => code.startsWith(p))?.[1] ?? DEFAULT_CHARS_PER_SECOND;
    return Math.floor(cps * rate * MAX_UTTERANCE_SECONDS);
}
/** Ways to break text, coarsest first: sentences, then clauses, then words. */
const BREAKS = [
    (text, lang) => typeof Intl.Segmenter === 'function'
        ? [...new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(text)].map(s => s.segment)
        : text.split(/(?<=[.!?。！？…]\s*)/), // browsers without Intl.Segmenter
    // browsers without Intl.Segmenter
    text => text.split(/(?<=[,;:，、；：])/),
    text => text.split(/(?<=\s)/),
];
/** `text` in pieces of at most `max` characters, broken at the most natural boundary that fits. */
function pieces(text, lang, max, level = 0) {
    if (text.length <= max)
        return [text];
    const breakAt = BREAKS[level];
    if (!breakAt) {
        // No boundary left (e.g. a long run of CJK without punctuation): cut evenly
        return Array.from({ length: Math.ceil(text.length / max) }, (_, i) => text.slice(i * max, (i + 1) * max));
    }
    return breakAt(text, lang).flatMap(part => pieces(part, lang, max, level + 1));
}
/**
 * Splits text for speech: sentence-sized pieces, packed together up to `max`
 * characters (by default, what fits in one utterance for the language) so short sentences still flow as one utterance. Pure.
 */
export function splitForSpeech(text, lang, max = maxUtteranceChars(lang)) {
    const chunks = [];
    for (const piece of pieces(text.trim(), lang, max)) {
        const last = chunks.length - 1;
        if (last >= 0 && chunks[last].length + piece.length <= max)
            chunks[last] += piece;
        else
            chunks.push(piece);
    }
    return chunks.map(c => c.trim()).filter(Boolean);
}
// The queued utterances are kept referenced until the last one ends, so
// Chromium's GC cannot collect them mid-playback and cut speech short.
let playing = [];
/** The recording being played (a sound file, or a voice service's answer). */
let recording = null;
/** Ends the wait of whatever is being read aloud now (stopSpeech, or the next sound). */
let settle = null;
const revoke = (src) => { if (src.startsWith('blob:'))
    URL.revokeObjectURL(src); };
/** Longest wait for the browser's voice to say it has finished (it sometimes never does). */
const browserWaitMs = (text) => 10_000 + text.length * 250;
/** Stops what is being read aloud: a recording or the browser's voice. */
export function stopSpeech() {
    if (recording) {
        recording.pause();
        revoke(recording.src);
    }
    recording = null;
    if ('speechSynthesis' in window)
        window.speechSynthesis.cancel();
    settle?.();
    settle = null;
}
/** A wait that ends when `done` is called, or when the next sound or stopSpeech() takes over. */
function waitTurn() {
    settle?.();
    let done = () => { };
    const ended = new Promise(resolve => {
        done = () => { if (settle === done)
            settle = null; resolve(); };
    });
    settle = done;
    return { done, ended };
}
/**
 * Plays a sound (a file URL, or a blob: URL it then owns). If it cannot be
 * played, `onFail` gets the error, unless something else started meanwhile.
 * The promise ends when the sound has played, was stopped, or failed (after
 * `onFail` has run).
 */
export function playSound(src, onFail) {
    return new Promise(resolve => {
        const turn = waitTurn();
        // A failure's fallback reads in its own turn (which ends this one): wait for the fallback instead
        let failed = false;
        void turn.ended.then(() => { if (!failed)
            resolve(); });
        const player = recording = new Audio(src);
        player.onended = () => { revoke(src); turn.done(); };
        player.play().catch(async (error) => {
            revoke(src);
            try {
                if (recording === player) {
                    recording = null;
                    failed = true;
                    await onFail(error);
                }
            }
            finally {
                turn.done();
                resolve();
            }
        });
    });
}
/**
 * The browser's own voice, at a learner-friendly rate (`code`: BCP-47), with
 * one of its voices by name when given. Ends when it has been said or stopped.
 */
export function speakWithBrowser(text, code, voiceName = '') {
    if (!('speechSynthesis' in window)) {
        notify(t('tts.noSupport'), 'err', 2500);
        return Promise.resolve();
    }
    window.speechSynthesis.cancel();
    const turn = waitTurn();
    const voice = voiceName ? window.speechSynthesis.getVoices?.().find(v => v.name === voiceName) : undefined;
    const queue = splitForSpeech(text, code).map(chunk => Object.assign(new SpeechSynthesisUtterance(chunk), { lang: voice?.lang ?? code, rate: SPEECH_RATE }, voice && { voice }));
    playing = queue;
    if (!queue.length) {
        turn.done();
        return turn.ended;
    }
    const last = queue[queue.length - 1];
    last.onend = last.onerror = () => { if (playing === queue)
        playing = []; turn.done(); };
    const timer = setTimeout(turn.done, browserWaitMs(text));
    queue.forEach(u => window.speechSynthesis.speak(u));
    return turn.ended.finally(() => clearTimeout(timer));
}
/** The browser's voices for a language (BCP-47 code, matched on its language part). */
export function browserVoices(code) {
    if (!('speechSynthesis' in window))
        return [];
    const lang = code.slice(0, 2).toLowerCase();
    return (window.speechSynthesis.getVoices?.() ?? []).filter(v => v.lang.toLowerCase().startsWith(lang)).map(v => v.name);
}
// ── Pronunciation scoring ─────────────────────────────────────────────────────
/**
 * Lower-cases, strips Latin diacritics (é→e) and punctuation.
 * Letters and digits of every script are kept, so non-Latin targets
 * (Japanese, Korean, Russian…) remain comparable.
 */
export function normalizeForPronunciation(text) {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}\s'-]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/** Pronunciation accuracy from 0 to 100 (normalised Levenshtein similarity). */
export function pronunciationScore(target, recognized) {
    const a = normalizeForPronunciation(target);
    if (!a)
        return 0;
    return similarityScore(a, normalizeForPronunciation(recognized));
}
const GRADES = [
    { min: 85, grade: 'excellent', label: 'tts.perfect' },
    { min: 65, grade: 'good', label: 'tts.great' },
    { min: 40, grade: 'fair', label: 'tts.keep' },
    { min: 0, grade: 'poor', label: 'tts.tryAgain' },
];
export function gradeFor(score) {
    return GRADES.find(g => score >= g.min) ?? GRADES[GRADES.length - 1];
}
// ── Speech recognition ────────────────────────────────────────────────────────
/** Some browsers expose the API but never fire any event when the mic is unusable. */
const SILENT_FAIL_MS = 10_000;
export function hasSpeechRecognition() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}
let activeRecognition = null;
export function setActiveRecognition(r) { activeRecognition = r; }
export function getActiveRecognition() { return activeRecognition; }
/** Stops the tracked recognition session, if any (e.g. when the panel closes). */
export function abortActiveRecognition() {
    activeRecognition?.abort();
    activeRecognition = null;
}
function setResult(el, state, text = '') {
    el.className = state === 'idle' ? 'pg-pronun-result' : `pg-pronun-result pg-pronun-${state}`;
    el.textContent = text;
}
/**
 * The score, and what was heard. For a sentence, the sentence itself with the
 * words not heard marked (missed-words.ts); a marked word, tapped, is read
 * alone where the drill handles data-action "say-word".
 */
function showScore(el, score, heard, target, code) {
    showResult(el, score, heard, missedWords(target, heard, code));
}
/** A word to tap and hear: one not heard (dotted underline) or said differently (wavy). */
const markedWord = (p, mark, title) => html `<span class="pg-pronun-${mark}" role="button" tabindex="0" data-action="say-word" data-word="${p.text}" title="${title}">${p.text}</span>`;
function showResult(el, score, heard, parts, details) {
    const { grade, label } = gradeFor(score);
    const sentence = parts.filter(p => p.word).length > 1;
    el.className = `pg-pronun-result pg-pronun-${grade}`;
    setHtml(el, html `
        <span class="pg-pronun-score">${score}</span>
        <span class="pg-pronun-label">${t(label)}</span>
        ${sentence
        ? html `<span class="pg-pronun-words" title="${heard}">${parts.map(p => p.missed ? markedWord(p, 'missed', t('speak.missed'))
            : p.wrong ? markedWord(p, 'wrong', t('pron.wrong', { n: p.score ?? 0 }))
                : p.text)}</span>`
        : html `<span class="pg-pronun-heard">"${heard}"</span>`}
        ${details && html `<span class="pg-pronun-sub">${t('pron.sub', {
        a: Math.round(details.accuracy), f: Math.round(details.fluency), c: Math.round(details.completeness)
    })}</span>`}`);
}
function setMicState(btn, listening) {
    btn.dataset.active = String(listening);
    btn.textContent = listening ? '🔴' : '🎤';
    btn.title = t(listening ? 'tts.listening' : 'fl.mic');
}
/** Picks the highest-confidence transcript of the first result. */
function bestTranscript(ev) {
    const alts = Array.from(ev.results[0] ?? []);
    return alts.reduce((best, alt) => (!best || alt.confidence > best.confidence ? alt : best), undefined)?.transcript ?? '';
}
/**
 * Listens for one utterance and scores it against `target`.
 * The mic button doubles as the stop button while listening.
 * `onSettled` runs once a score or an error is shown (not when the user cancels).
 * @returns the recognition session (call .abort() to cancel), or null if unsupported.
 */
export function runPronunciationCheck(target, lang, micBtn, resultEl, onSettled) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        setResult(resultEl, 'error', t('tts.noRecog'));
        return null;
    }
    const recognition = Object.assign(new SR(), {
        lang: speechLangCode(lang),
        continuous: false,
        interimResults: false,
        maxAlternatives: 3,
    });
    // Only the first of result / error / timeout is acted on.
    let settled = false;
    const settle = () => !settled && (settled = true);
    const alive = () => document.contains(resultEl);
    setMicState(micBtn, true);
    setResult(resultEl, 'listening', t('tts.listening'));
    // While listening, a tap stops; it must not reach the feature's own click listener
    const stop = (e) => { e.stopPropagation(); recognition.abort(); };
    micBtn.onclick = stop;
    const fail = (message) => { setResult(resultEl, 'error', message); onSettled?.(); };
    recognition.onresult = (ev) => {
        if (!alive() || !settle())
            return;
        const heard = bestTranscript(ev);
        showScore(resultEl, pronunciationScore(target, heard), heard.trim(), target, recognition.lang);
        onSettled?.();
    };
    recognition.onerror = (ev) => {
        if (!alive() || !settle())
            return;
        if (ev.error === 'aborted' || ev.error === 'no-speech') {
            setMicState(micBtn, false);
            setResult(resultEl, 'idle');
        }
        else {
            fail(ev.error === 'not-allowed' ? t('tts.noMic') : t('tts.recogError', { err: ev.error }));
        }
    };
    const silentFailTimer = setTimeout(() => {
        if (!settle())
            return;
        recognition.abort();
        if (!alive())
            return;
        fail(t('tts.noRecog'));
        setMicState(micBtn, false);
    }, SILENT_FAIL_MS);
    // onend always fires last, after result or error.
    recognition.onend = () => {
        clearTimeout(silentFailTimer);
        // Back to the feature: its listener starts the next attempt
        if (micBtn.onclick === stop)
            micBtn.onclick = null;
        if (!alive())
            return;
        if (settle())
            fail(t('tts.noSpeech'));
        setMicState(micBtn, false);
    };
    recognition.start();
    return recognition;
}
export const canRecordCheck = canRecord;
const SERVICE_ERRORS = {
    key: 'pron.errKey', network: 'pron.errNetwork', language: 'pron.errLang', nothing: 'tts.noSpeech', other: 'pron.errOther',
};
const errorMessage = (e) => {
    if (e instanceof PronServiceError)
        return t(SERVICE_ERRORS[e.kind], { msg: e.message });
    if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'NotFoundError'))
        return t('tts.noMic');
    return t('pron.errOther', { msg: String(e.message ?? e) });
};
const noteProblem = (e) => {
    const quiet = (e instanceof PronServiceError && e.kind === 'nothing') || (e instanceof DOMException && e.name === 'NotAllowedError');
    if (!quiet)
        recordProblem('voice', `pronunciation check: ${String(e.message ?? e)}`);
};
/** Puts the advice button under a result; the recording is converted and sent only when it is pressed. */
function addAdvice(resultEl, recording, target, advice, signal) {
    const box = document.createElement('span');
    box.className = 'pg-pronun-advice';
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'pg-pronun-advice-btn', textContent: `🗣 ${t('pron.advice')}` });
    box.append(btn);
    resultEl.append(box);
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.remove();
        box.textContent = t('pron.adviceWait');
        try {
            const tips = await advise(advice.cfg, await toWav16k(recording), target, advice.studyLang, advice.nativeLang, signal);
            box.textContent = tips;
        }
        catch (err) {
            if (signal.aborted)
                return;
            noteProblem(err);
            box.textContent = errorMessage(err);
        }
    });
}
/**
 * Records one utterance and has a service check it against `target`:
 * Azure scores it (overall, accuracy · fluency · completeness, and for a
 * sentence the words not said and said differently); an OpenAI-compatible
 * transcription is compared like the browser's recognition. With `advice`, a
 * button under the result asks an audio model for tips on the same recording.
 * The mic button ends the recording early (it also ends a moment after the
 * speaker stops). Same contract as runPronunciationCheck: `onSettled` after a
 * result or an error, not on cancel.
 */
export function runRecordedCheck(target, lang, engine, micBtn, resultEl, onSettled, advice) {
    const locale = knownLangCode(lang);
    // Azure needs the language; a transcription tells it from the recording when Polyglot has no code for it
    if (!locale && engine.kind === 'azure') {
        setResult(resultEl, 'error', t('pron.errLang'));
        return null;
    }
    const alive = () => document.contains(resultEl);
    const request = new AbortController();
    let cancelled = false;
    let recording = null;
    setMicState(micBtn, true);
    setResult(resultEl, 'listening', t('tts.listening'));
    // While recording, a tap ends it (and checks what was said); it must not reach the feature's own listener
    const stop = (e) => { e.stopPropagation(); recording?.stop(); };
    micBtn.onclick = stop;
    const finish = () => { if (micBtn.onclick === stop)
        micBtn.onclick = null; if (alive())
        setMicState(micBtn, false); };
    void (async () => {
        try {
            recording = await startRecording();
            if (cancelled) {
                recording.abort();
                return;
            }
            const said = await recording.done;
            finish();
            if (cancelled)
                return;
            if (!said) {
                if (alive())
                    setResult(resultEl, 'idle');
                return;
            }
            setResult(resultEl, 'listening', t('pron.assessing'));
            if (engine.kind === 'azure') {
                const result = await assessPronunciation(engine.cfg, await toWav16k(said), target, locale ?? '', request.signal);
                if (!alive() || cancelled)
                    return;
                showResult(resultEl, Math.round(result.score), result.text, scoredWords(target, result.words, locale ?? ''), result);
            }
            else {
                const heard = await transcribe(engine.cfg, said, locale ?? '', request.signal);
                if (!alive() || cancelled)
                    return;
                showScore(resultEl, pronunciationScore(target, heard), heard, target, locale ?? speechLangCode(lang));
            }
            if (advice)
                addAdvice(resultEl, said, target, advice, request.signal);
            onSettled?.();
        }
        catch (e) {
            // Stopped: abort() already reset the mic, which may belong to the next check by now
            if (cancelled)
                return;
            finish();
            if (!alive())
                return;
            noteProblem(e);
            setResult(resultEl, 'error', errorMessage(e));
            onSettled?.();
        }
    })();
    return {
        abort: () => { cancelled = true; recording?.abort(); request.abort(); finish(); if (alive())
            setResult(resultEl, 'idle'); },
    };
}
