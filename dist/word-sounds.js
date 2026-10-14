// A word's sounds: its own (`audio`) and its example's (`example_audio`) — pure.
//
//   soundText      what a sound reads (the word, or its example)
//   isMadeSound    made by a voice service (tts.ts), not a recording from Anki
//   withSound      the entry with a sound set; withoutSound, with one removed
//   lacksSound     a sound that could be made is missing (the "no sound" filter)
//   soundLang      the language a word is read in: its own, else the study language
//   soundJob       one sound to make, with the word as it was when asked for
//   jobFits        the word is still as the job found it (else its sound is not kept)
//   planSounds     what a "make sounds" run would make: missing sounds, or also
//                  the made ones to remake with the current voice
//   mergeSounds    two copies of a word combined: an example keeps its own sound,
//                  a made sound stays with the word it reads, made marks united
//   renamedSounds  a renamed word drops the made sound of its old spelling
//
// Made sounds are listed by file name in `made_sounds`. A sound replaced by
// any other path (an Anki import, a restore) has a different name, so it is
// never mistaken for a made one, and remaking never touches a recording.
import { langKey } from './utils.js';
export const SOUND_FIELDS = ['audio', 'example_audio'];
/** What the sound reads: the word, or its example ('' when it has none). */
export const soundText = (e, field) => (field === 'audio' ? e.word : e.example ?? '').trim();
export const hasSound = (e, field) => !!e[field];
/** The sound was made by a voice service (and can be remade). */
export const isMadeSound = (e, field) => !!e[field] && (e.made_sounds ?? []).includes(e[field]);
/** The made-sound list kept to the sounds the entry still has; absent when empty. */
export function withMadeList(e, made) {
    const current = new Set(SOUND_FIELDS.map(f => e[f]).filter(Boolean));
    const list = [...new Set(made)].filter(n => current.has(n));
    const { made_sounds: _old, ...rest } = e;
    return list.length ? { ...rest, made_sounds: list } : rest;
}
/** The entry with `name` as its sound (`made`: by a voice service). */
export function withSound(e, field, name, made) {
    const next = { ...e, [field]: name };
    const others = (e.made_sounds ?? []).filter(n => n !== name);
    return withMadeList(next, made ? [...others, name] : others);
}
/** The entry without that sound (its file is listed for deletion at the next save when no word uses it). */
export function withoutSound(e, field) {
    const next = { ...e };
    delete next[field];
    return withMadeList(next, e.made_sounds ?? []);
}
/** A sound the entry could have is missing: the word's, or its example's. */
export const lacksSound = (e) => SOUND_FIELDS.some(f => !!soundText(e, f) && !hasSound(e, f));
/**
 * The language a word is read in: the study language it was saved under, or
 * `studyLang` (the current one) when it was saved under that or is untagged.
 */
export function soundLang(e, studyLang) {
    const langs = e.langs ?? [];
    return !langs.length || langs.includes(langKey(studyLang)) ? studyLang : langs[0];
}
/** The job for one of the entry's sounds; null when there is nothing to read. */
export function soundJob(e, field, studyLang) {
    const text = soundText(e, field);
    return text ? { word: e.word, field, text, lang: soundLang(e, studyLang), current: e[field] ?? '' } : null;
}
/**
 * The word is still as the job found it: same text to read and the same sound
 * file. A sound made for an example that changed since, for a word renamed, or
 * for a sound removed or replaced meanwhile is not kept.
 */
export const jobFits = (e, job) => !!e && soundText(e, job.field) === job.text && (e[job.field] ?? '') === job.current;
/** The sounds a run makes for these entries, the word's before its example's. */
export function planSounds(entries, mode, studyLang) {
    const jobs = [];
    for (const e of entries) {
        for (const field of SOUND_FIELDS) {
            const job = soundJob(e, field, studyLang);
            if (job && (!hasSound(e, field) || (mode === 'remake' && isMadeSound(e, field))))
                jobs.push(job);
        }
    }
    return jobs;
}
/** Characters a run sends (what most services charge by). */
export const planChars = (jobs) => jobs.reduce((n, j) => n + j.text.length, 0);
/** How many of the jobs are of each kind, for the confirmation. */
export function planCounts(jobs) {
    const counts = { audio: 0, example_audio: 0 };
    for (const j of jobs)
        counts[j.field]++;
    return counts;
}
// ── Merging copies ────────────────────────────────────────────────────────────
/** The example and what belongs to it: they always come from the same copy. */
export const EXAMPLE_FIELDS = ['example', 'example_translation', 'example_form', 'example_audio'];
/** `out` with the example fields taken from `from` (absent where `from` has none). */
export function withExampleOf(out, from) {
    const next = { ...out };
    for (const k of EXAMPLE_FIELDS) {
        if (from[k] !== undefined)
            next[k] = from[k];
        else
            delete next[k];
    }
    return next;
}
/**
 * The sounds of `out`, a merge of `a` (the copy kept) and `b`: when the two
 * have different examples, the kept example brings its own sound (or none);
 * a sound `b` made for a different word is not carried over; both copies'
 * made marks are united.
 */
export function mergeSounds(a, b, out) {
    let next = a.example && b.example && a.example !== b.example ? withExampleOf(out, a) : out;
    if (next.audio && next.audio === b.audio && b.word !== next.word && isMadeSound(b, 'audio')) {
        next = { ...next };
        delete next.audio;
    }
    return withMadeList(next, [...(a.made_sounds ?? []), ...(b.made_sounds ?? [])]);
}
/** A word renamed from `oldWord`: a made sound of the old spelling no longer fits (a recording is kept). */
export function renamedSounds(e, oldWord) {
    return e.word !== oldWord && isMadeSound(e, 'audio') ? withoutSound(e, 'audio') : e;
}
