// Which voice reads a character's lines (ui/line-voice.ts).
//
//   browser and direct services   a voice per character, set in Polyglot's voice
//                                 settings and kept per service (a voice id of one
//                                 service means nothing to another); none set:
//                                 the service's voice from the settings
//   SillyTavern's TTS             its own voice map (Extensions → TTS, a voice per
//                                 character): /speak gets the character's name when
//                                 the map has it, else the voice set in Polyglot
//
// The speaker of a line is the character the message is from: lines quoted
// from someone else in the same message are read in that character's voice.
import { getSettings, saveSettings, getContext } from './runtime.js';
import { extension_settings } from './st.js';
const castOf = (provider) => {
    const value = getSettings().voice_cast?.[provider];
    return value && typeof value === 'object' ? value : {};
};
/** The voice set for a character's lines with this service ('' when none is). */
export function castVoice(provider, speaker) {
    if (!speaker)
        return '';
    const voice = castOf(provider)[speaker];
    return typeof voice === 'string' ? voice.trim() : '';
}
/** Sets (or, with '', clears) the voice of a character's lines with this service. */
export function setCastVoice(provider, speaker, voice) {
    const s = getSettings();
    const cast = { ...castOf(provider) };
    if (voice.trim())
        cast[speaker] = voice.trim();
    else
        delete cast[speaker];
    s.voice_cast = { ...(s.voice_cast ?? {}), [provider]: cast };
    saveSettings();
}
/** Characters with a voice set for this service. */
export const castNames = (provider) => Object.keys(castOf(provider));
/** The characters of the open chat: the character, or a group's members. */
export function chatCharacters() {
    const ctx = getContext();
    if (ctx.groupId) {
        const members = ctx.groups?.find(g => g.id === ctx.groupId)?.members ?? [];
        return members.map(avatar => ctx.characters?.find(c => c.avatar === avatar)?.name).filter((n) => !!n);
    }
    return ctx.name2 ? [ctx.name2] : [];
}
/** Turned off in ST's voice map. */
const ST_DISABLED = 'disabled';
/** The characters in SillyTavern's TTS voice map that have a voice (the map is "Name:voice, …" or an object). */
export function stVoiceMap() {
    const tts = extension_settings.tts;
    const provider = typeof tts?.currentProvider === 'string' ? tts.currentProvider : '';
    const map = tts?.[provider]?.voiceMap;
    const entries = typeof map === 'string'
        ? map.split(',').map(pair => pair.split(':').map(p => p.trim()))
        : map && typeof map === 'object' ? Object.entries(map) : [];
    return new Set(entries.filter(([name, voice]) => name && typeof voice === 'string' && voice && voice !== ST_DISABLED).map(([name]) => name));
}
/** The voice name /speak gets for a character's lines: the character's own in ST's voice map, else `fallback`. */
export function stVoiceFor(speaker, fallback) {
    return speaker && stVoiceMap().has(speaker) ? speaker : fallback;
}
