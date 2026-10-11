// Text-to-speech and pronunciation scoring (Web Speech API).
//
// Design rules:
//   • Pure scoring helpers (speechLangCode, normalizeForPronunciation,
//     pronunciationScore) have no DOM access and are unit-tested.
//   • Only one recognition session is tracked at a time so closing the panel
//     can stop the microphone (abortActiveRecognition).
import { similarityScore } from './utils.js';
import { notify } from './ui.manager.js';
import { html, setHtml } from './html.js';
import { t } from './i18n.js';
import { userFileUrl } from './user-files.js';
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
/** Maps a free-text language name ("Japanese", "Español") to a BCP-47 code. */
export function speechLangCode(lang) {
    const l = lang.toLowerCase();
    return LANG_CODES.find(([needles]) => needles.some(n => l.includes(n)))?.[1] ?? 'en-US';
}
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
/** The recording being played (a word's own audio file). */
let recording = null;
/**
 * Speaks text aloud at a learner-friendly rate, interrupting any ongoing
 * speech. With `audio` (a recorded file in the user's files, e.g. from Anki)
 * the recording is played instead; if it cannot be played, the text is spoken.
 */
export function speak(text, lang, audio) {
    recording?.pause();
    recording = null;
    if (audio) {
        if ('speechSynthesis' in window)
            window.speechSynthesis.cancel();
        const player = recording = new Audio(userFileUrl(audio));
        player.play().catch(() => { if (recording === player) {
            recording = null;
            speak(text, lang);
        } });
        return;
    }
    if (!('speechSynthesis' in window)) {
        notify(t('tts.noSupport'), 'err', 2500);
        return;
    }
    window.speechSynthesis.cancel();
    const code = speechLangCode(lang);
    const queue = splitForSpeech(text, code).map(chunk => Object.assign(new SpeechSynthesisUtterance(chunk), { lang: code, rate: SPEECH_RATE }));
    playing = queue;
    if (!queue.length)
        return;
    queue[queue.length - 1].onend = () => { if (playing === queue)
        playing = []; };
    queue.forEach(u => window.speechSynthesis.speak(u));
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
function showScore(el, score, heard) {
    const { grade, label } = gradeFor(score);
    el.className = `pg-pronun-result pg-pronun-${grade}`;
    setHtml(el, html `
        <span class="pg-pronun-score">${score}</span>
        <span class="pg-pronun-label">${t(label)}</span>
        <span class="pg-pronun-heard">"${heard}"</span>`);
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
        showScore(resultEl, pronunciationScore(target, heard), heard.trim());
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
