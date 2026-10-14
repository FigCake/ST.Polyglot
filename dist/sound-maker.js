// Making words' sounds with the voice service chosen in the settings (tts.ts)
// and keeping them as files on the words (word-sounds.ts).
//
//   soundsBlocked()   why sounds cannot be made and kept now ('' when they can)
//   makeSound()       a service's MP3 for a text, kept for the session
//   keepWordSound()   stores a made sound for a job (word-sounds.SoundJob)
//   remakeWordSound() makes one word's sound again and replaces it
//   runSounds()       a "make sounds" run: one request at a time, stoppable
//
// Design rules:
//   • No UI: callers show progress and notices (ui/sound-bar.ts, voice.ts).
//   • A sound is kept only while the word is still as its job found it
//     (word-sounds.jobFits): same text, same sound file. What a job may
//     replace is decided when the job is made, never at storing time.
//   • A failed upload is a failure: it is counted and can end a run, so a run
//     never pays for sounds it cannot keep.
import { getSettings } from './runtime.js';
import { storeMode } from './data-store.js';
import { writeUserFile } from './user-files.js';
import { notePending, noteUploaded, existingMedia, mediaFileName } from './media-files.js';
import { loadWordbook, saveWordbook } from './wordbook.js';
import { knownLangCode } from './speech.js';
import { ttsConfig, missingFor, synthesize, cacheKey, soundFormat, DIRECT_PROVIDERS, TtsError } from './tts.js';
import { withSound, jobFits } from './word-sounds.js';
import { getRequestHeaders } from './st.js';
export function soundsBlocked() {
    const c = ttsConfig(getSettings());
    if (!DIRECT_PROVIDERS.includes(c.provider))
        return 'service';
    const missing = missingFor(c);
    if (missing)
        return missing;
    return storeMode() === 'file' ? '' : 'storage';
}
/** A direct service is chosen and sounds can be kept: show the tools for making them (a missing key is said on use). */
export const soundsOffered = () => !['service', 'storage'].includes(soundsBlocked());
// ── Making ────────────────────────────────────────────────────────────────────
/** Answers of this session, by what they say and how (a word heard twice is paid once). */
const heard = new Map();
const HEARD_MAX = 60;
/** Requests on their way: pressing 🔊 again before the answer does not pay twice. */
const asked = new Map();
/** The chosen direct service's MP3 for `text`, read in language `lang` (a language name). */
export async function makeSound(text, lang, { signal, fresh = false, cache = true, voice } = {}) {
    const c = { ...ttsConfig(getSettings()), ...(voice && { voice }) };
    // '' for a language Polyglot does not know: the service's own voice decides (a Google voice, its language)
    const code = knownLangCode(lang) ?? '';
    const key = cacheKey(c, `${lang}\u0002${text}`, code);
    const kept = fresh ? undefined : heard.get(key);
    if (kept)
        return kept;
    // A request that can be stopped is not shared: stopping it must not fail someone else's
    const shared = !signal && !fresh;
    const pending = shared ? asked.get(key) : undefined;
    if (pending)
        return pending;
    const request = synthesize(c, text, code, getRequestHeaders(), signal);
    if (shared)
        asked.set(key, request);
    try {
        const bytes = await request;
        if (cache) {
            heard.delete(key);
            heard.set(key, bytes);
            if (heard.size > HEARD_MAX)
                heard.delete(heard.keys().next().value);
        }
        return bytes;
    }
    finally {
        if (asked.get(key) === request)
            asked.delete(key);
    }
}
const fits = (job) => jobFits(loadWordbook().find(e => e.word === job.word), job);
/**
 * Puts a made sound in the user's files; its name, or null when the upload
 * failed. Names are the content's hash: a file already there (or waiting to
 * be deleted) is reused, and kept off the deletion queue.
 *
 * The file is listed in the browser (notePending) but not yet noted as this
 * session's upload: a save that runs before setSounds would list a noted
 * file no word uses yet for deletion. setSounds notes it, right before the words get it.
 */
async function upload(bytes) {
    const name = mediaFileName(bytes, `voice.${soundFormat(bytes) ?? 'mp3'}`);
    if ((await existingMedia([name])).has(name))
        return name;
    notePending([name]);
    return await writeUserFile(name, bytes) === 'ok' ? name : null;
}
/**
 * Sets an uploaded sound on its word if it still fits; true when set. The
 * file is noted first, in the same step (no save can run in between): saves
 * keep it while the word uses it, and delete it if the word changed meanwhile.
 * `burst`: one of a run's sounds, saved with the others a few seconds later.
 */
function setSound(job, name, burst = false) {
    noteUploaded([name]);
    const wordbook = loadWordbook();
    const i = wordbook.findIndex(e => e.word === job.word);
    if (i < 0 || !jobFits(wordbook[i], job))
        return false;
    wordbook[i] = withSound(wordbook[i], job.field, name, true);
    saveWordbook(wordbook, burst);
    return true;
}
/** Stores a made sound for the job, if the word is still as the job found it. */
export async function keepWordSound(job, bytes) {
    if (storeMode() !== 'file' || !fits(job))
        return 'skipped';
    const name = await upload(bytes);
    if (!name)
        return 'failed';
    // Checked again inside: the word may have changed during the upload
    return setSound(job, name) ? 'stored' : 'skipped';
}
/** Makes the job's sound again with the current voice and stores it in place of what the job found. */
export async function remakeWordSound(job) {
    return keepWordSound(job, await makeSound(job.text, job.lang, { fresh: true, cache: false }));
}
/** Failures in a row after which a run gives up (a wrong key, a used-up quota or a full disk fails every time). */
const MAX_FAILURES_IN_A_ROW = 3;
let run = null;
export const isSoundRunActive = () => run !== null;
export const stopSoundRun = () => run?.abort();
/**
 * Makes and stores the jobs' sounds one at a time. A remake run (`fresh`) asks
 * the service again even for text this session has heard.
 */
export async function runSounds(jobs, fresh, onProgress) {
    if (run)
        throw new Error('a sound run is already active');
    const controller = run = new AbortController();
    const result = { made: 0, failed: 0, stopped: false, gaveUp: false };
    let inARow = 0;
    // Set by a failure that every later job would hit; the run gives up if jobs remain
    let hopeless = false;
    const fail = (message, fatal = false) => {
        result.failed++;
        result.error = message;
        hopeless = fatal || ++inARow >= MAX_FAILURES_IN_A_ROW;
    };
    try {
        for (const [i, job] of jobs.entries()) {
            onProgress(i, jobs.length);
            if (controller.signal.aborted)
                break;
            if (hopeless) {
                result.gaveUp = true;
                break;
            }
            if (storeMode() !== 'file') {
                fail('storage', true);
                result.gaveUp = true;
                break;
            }
            if (!fits(job))
                continue;
            try {
                const bytes = await makeSound(job.text, job.lang, { signal: controller.signal, fresh, cache: false });
                const name = await upload(bytes);
                if (!name) {
                    fail('upload');
                    continue;
                }
                // On the word at once (🔊 plays it, saves keep its file); written to the file every few seconds
                if (setSound(job, name, true))
                    result.made++;
                inARow = 0;
            }
            catch (e) {
                if (controller.signal.aborted)
                    break;
                // Nothing will get through when the service cannot be reached at all
                fail(e.message, e instanceof TtsError && e.network);
            }
        }
    }
    finally {
        result.stopped = controller.signal.aborted;
        run = null;
        // The last sounds are written now, not a few seconds later
        if (result.made)
            saveWordbook(loadWordbook());
    }
    return result;
}
