// Reading words aloud: which voice reads, and keeping what a service made.
//
//   speak(text, lang, { audio, keep })
//     1. the word's own sound file (`audio`)
//     2. the voice chosen in the settings:
//          direct service (tts.ts via sound-maker.ts) ─▶ played, and with
//          `keep` stored as the word's sound (setting voice_save)
//          ST's TTS extension (/speak), when it is turned on in ST
//     3. the browser's voice, when the others are missing or fail
//
// A word's sound is read in the word's own language (word-sounds.soundLang).
// A sound file that has gone from the server (deleted on another device) is
// replaced by the service's new sound, so it is not paid for at every press.
//
//   speakAll(lines, lang)   a message's lines of dialogue one after another, each
//                           in its speaker's voice (voice-cast.ts)
//
// Both return when the reading has ended (or was stopped: stopSpeaking(), or
// any newer reading).
import { notify } from './ui.manager.js';
import { t } from './i18n.js';
import { userFileUrl } from './user-files.js';
import { getSettings } from './runtime.js';
import { mediaGone } from './media-files.js';
import { loadWordbook } from './wordbook.js';
import { stopSpeech, playSound, speakWithBrowser, speechLangCode, knownLangCode } from './speech.js';
import { castVoice, stVoiceFor } from './voice-cast.js';
import { HOST } from './host.js';
import { ttsConfig, missingFor, listVoices, DIRECT_PROVIDERS, TtsError } from './tts.js';
import { makeSound, keepWordSound } from './sound-maker.js';
import { soundJob } from './word-sounds.js';
import { getRequestHeaders, SlashCommandParser, extension_settings } from './st.js';
/** Counts speak() calls: a slow answer for an earlier call is not played over a later one. */
let turn = 0;
/** The reading that was last told ST's TTS is off. */
let stOffNoted = -1;
/** Tells what went wrong with a voice service: a request that never got an answer points to ST's proxy. */
export function notifyVoiceError(e) {
    const network = e instanceof TtsError && e.network && !getSettings().voice_proxy;
    notify(t(network ? (HOST.stVoice ? 'tts.blocked' : 'tts.blockedDirect') : 'tts.failed', { msg: e.message }), 'err', 6000);
}
/**
 * ST's TTS extension (/speak), with the voice set up there. Each text goes in
 * quotes so ST's "only quoted text" setting still reads it; several texts go
 * in one command, as ST plays one /speak at a time. False when the extension
 * is missing or turned off in ST (its command stays registered).
 */
function speakWithSt(texts, voice) {
    const command = SlashCommandParser.commands?.speak;
    if (!command || extension_settings.tts?.enabled !== true)
        return false;
    try {
        const quoted = texts.map(text => `"${text.replace(/["“”]/g, '')}"`).join(' ');
        Promise.resolve(command.callback(voice ? { voice } : {}, quoted)).catch(() => { });
        return true;
    }
    catch {
        return false;
    }
}
/** Reads `text` with the voice chosen in the settings (or the speaker's), falling back to the browser's voice. */
async function speakWithVoice(text, lang, job, mine, speaker) {
    const code = speechLangCode(lang);
    const s = ttsConfig(getSettings());
    const voice = castVoice(s.provider, speaker);
    if (s.provider === 'st') {
        if (speakWithSt([text], stVoiceFor(speaker, s.voice)))
            return;
        // Once per reading, not at every line of a run
        if (stOffNoted !== mine)
            notify(t('tts.stOff'), 'warn', 3500);
        stOffNoted = mine;
    }
    if (!DIRECT_PROVIDERS.includes(s.provider))
        return speakWithBrowser(text, code, s.provider === 'browser' ? voice : '');
    const c = voice ? { ...s, voice } : s;
    const missing = missingFor(c);
    if (missing) {
        notify(t(missing === 'key' ? 'tts.needKey' : 'tts.needVoice'), 'warn', 3500);
        return speakWithBrowser(text, code);
    }
    let bytes;
    try {
        bytes = await makeSound(text, lang, { voice });
    }
    catch (e) {
        if (turn !== mine)
            return;
        notifyVoiceError(e);
        return speakWithBrowser(text, code);
    }
    if (job && getSettings().voice_save !== false)
        void keepWordSound(job, bytes);
    if (turn !== mine)
        return;
    return playSound(URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })), () => {
        if (turn === mine)
            return speakWithBrowser(text, code);
    });
}
/** The job that keeps this sound on its word: only when `text` is what the word's sound reads. */
function jobFor(text, lang, keep) {
    const entry = keep && loadWordbook().find(e => e.word === keep.word);
    const job = entry && keep ? soundJob(entry, keep.field, lang) : null;
    return job && job.text === text.trim() ? job : null;
}
/** One reading: the word's file when there is one, else the chosen voice. */
function say(text, lang, { audio, keep, speaker }, mine) {
    const job = jobFor(text, lang, keep);
    const readIn = job?.lang ?? lang;
    // The word's sound as it is now: a card drawn earlier may not know of one stored or removed since
    const file = job ? job.current : audio;
    if (!file)
        return speakWithVoice(text, readIn, job, mine, speaker);
    return playSound(userFileUrl(file), async () => {
        // A file known to be gone is replaced by the new sound; one that is there (or may be) is kept
        const gone = !!job && await mediaGone(file);
        if (turn === mine)
            await speakWithVoice(text, readIn, gone ? job : null, mine, speaker);
    });
}
/**
 * Speaks text aloud, interrupting any ongoing speech: the word's own sound file
 * when given, else the voice chosen in the settings. With `keep`, a direct
 * voice service's sound is stored on that word, and it is read in the word's
 * own language. Ends when the reading has ended or was stopped.
 */
export function speak(text, lang, options = {}) {
    stopSpeech();
    return say(text, lang, options, ++turn);
}
/** Stops reading aloud, a run of lines (speakAll) included. */
export function stopSpeaking() {
    turn++;
    stopSpeech();
}
/**
 * Reads lines one after another, each in its speaker's voice; a voice
 * service is asked for the next line while one plays. `onLine` hears which
 * line is being read, then -1 when the run ends or is stopped. With ST's TTS
 * the lines go to it in one /speak (it plays them in turn itself).
 */
export async function speakAll(lines, lang, onLine = () => { }) {
    stopSpeech();
    const mine = ++turn;
    const s = ttsConfig(getSettings());
    try {
        if (s.provider === 'st' && lines.length && speakWithSt(lines.map(l => l.text), stVoiceFor(lines[0].speaker, s.voice)))
            return;
        for (let i = 0; i < lines.length && turn === mine; i++) {
            onLine(i);
            const reading = say(lines[i].text, lang, { speaker: lines[i].speaker }, mine);
            // The next line is asked for while this one plays
            const next = lines[i + 1];
            if (next && DIRECT_PROVIDERS.includes(s.provider)) {
                const voice = castVoice(s.provider, next.speaker);
                if (!missingFor(voice ? { ...s, voice } : s))
                    void makeSound(next.text, lang, { voice }).catch(() => { });
            }
            await reading;
        }
    }
    finally {
        onLine(-1);
    }
}
/** The chosen voice service's voices for the study language (ElevenLabs, Google; [] for the others; all of Google's for a language Polyglot does not know). */
export const voiceList = (lang) => listVoices(ttsConfig(getSettings()), knownLangCode(lang) ?? '', getRequestHeaders());
/** A short greeting in the language, to try a voice. */
const SAMPLES = {
    it: 'Ciao! Come stai oggi?', es: 'Hola, ¿qué tal estás hoy?', fr: 'Bonjour, comment ça va aujourd’hui ?',
    de: 'Hallo, wie geht es dir heute?', ja: 'こんにちは、今日は元気ですか？', zh: '你好，今天过得怎么样？',
    ko: '안녕하세요, 오늘 기분이 어때요?', pt: 'Olá, como você está hoje?', en: 'Hello, how are you today?',
};
/** Reads a greeting in the study language with the chosen voice (the settings' "try" button). */
export function tryVoice(lang) {
    speak(SAMPLES[speechLangCode(lang).slice(0, 2)] ?? SAMPLES.en, lang);
}
