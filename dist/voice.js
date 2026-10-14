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
import { notify } from './ui.manager.js';
import { t } from './i18n.js';
import { userFileUrl } from './user-files.js';
import { getSettings } from './runtime.js';
import { mediaGone } from './media-files.js';
import { loadWordbook } from './wordbook.js';
import { stopSpeech, playSound, speakWithBrowser, speechLangCode, knownLangCode } from './speech.js';
import { ttsConfig, missingFor, listVoices, DIRECT_PROVIDERS, TtsError } from './tts.js';
import { makeSound, keepWordSound } from './sound-maker.js';
import { soundJob } from './word-sounds.js';
import { getRequestHeaders, SlashCommandParser, extension_settings } from './st.js';
/** Counts speak() calls: a slow answer for an earlier call is not played over a later one. */
let turn = 0;
/** Tells what went wrong with a voice service: a request that never got an answer points to ST's proxy. */
export function notifyVoiceError(e) {
    const network = e instanceof TtsError && e.network && !getSettings().voice_proxy;
    notify(t(network ? 'tts.blocked' : 'tts.failed', { msg: e.message }), 'err', 6000);
}
/**
 * ST's TTS extension (/speak), with the voice set up there. The text goes in
 * quotes so ST's "only quoted text" setting still reads it. False when the
 * extension is missing or turned off in ST (its command stays registered).
 */
function speakWithSt(text, voice) {
    const command = SlashCommandParser.commands?.speak;
    if (!command || extension_settings.tts?.enabled !== true)
        return false;
    try {
        const quoted = `"${text.replace(/["“”]/g, '')}"`;
        Promise.resolve(command.callback(voice ? { voice } : {}, quoted)).catch(() => { });
        return true;
    }
    catch {
        return false;
    }
}
/** Reads `text` with the voice chosen in the settings, falling back to the browser's voice. */
async function speakWithVoice(text, lang, job, mine) {
    const code = speechLangCode(lang);
    const c = ttsConfig(getSettings());
    if (c.provider === 'st') {
        if (speakWithSt(text, c.voice))
            return;
        notify(t('tts.stOff'), 'warn', 3500);
    }
    if (!DIRECT_PROVIDERS.includes(c.provider)) {
        speakWithBrowser(text, code);
        return;
    }
    const missing = missingFor(c);
    if (missing) {
        notify(t(missing === 'key' ? 'tts.needKey' : 'tts.needVoice'), 'warn', 3500);
        speakWithBrowser(text, code);
        return;
    }
    let bytes;
    try {
        bytes = await makeSound(text, lang);
    }
    catch (e) {
        if (turn !== mine)
            return;
        notifyVoiceError(e);
        speakWithBrowser(text, code);
        return;
    }
    if (job && getSettings().voice_save !== false)
        void keepWordSound(job, bytes);
    if (turn !== mine)
        return;
    playSound(URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })), () => {
        if (turn === mine)
            speakWithBrowser(text, code);
    });
}
/** The job that keeps this sound on its word: only when `text` is what the word's sound reads. */
function jobFor(text, lang, keep) {
    const entry = keep && loadWordbook().find(e => e.word === keep.word);
    const job = entry && keep ? soundJob(entry, keep.field, lang) : null;
    return job && job.text === text.trim() ? job : null;
}
/**
 * Speaks text aloud, interrupting any ongoing speech: the word's own sound file
 * when given, else the voice chosen in the settings. With `keep`, a direct
 * voice service's sound is stored on that word, and it is read in the word's
 * own language.
 */
export function speak(text, lang, { audio, keep } = {}) {
    stopSpeech();
    const mine = ++turn;
    const job = jobFor(text, lang, keep);
    const readIn = job?.lang ?? lang;
    // The word's sound as it is now: a card drawn earlier may not know of one stored or removed since
    const file = job ? job.current : audio;
    if (!file) {
        void speakWithVoice(text, readIn, job, mine);
        return;
    }
    playSound(userFileUrl(file), async () => {
        // A file known to be gone is replaced by the new sound; one that is there (or may be) is kept
        const gone = !!job && await mediaGone(file);
        if (turn === mine)
            void speakWithVoice(text, readIn, gone ? job : null, mine);
    });
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
