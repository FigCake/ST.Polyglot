// ════════════════════════════
// Polyglot  anki/import.ts
// ════════════════════════════
// Puts Anki rows into the wordbook, with their media.
//
//   rows ─▶ media used by the rows ─▶ user files  pg-media-<hash>.<ext>
//        ─▶ entries (one set per deck) ─▶ merged into the wordbook
//
// Media files are named by their content, so importing the same deck again
// (or two decks sharing a file) stores each file once; a file already on the
// server is not uploaded again. Existing words keep their text: an import
// only fills what is empty and adds the word to the deck's set.
//
// Dependencies: constants.ts, runtime.ts, storage.ts, data-store.ts,
//               user-files.ts, media-files.ts, wordbook.ts, wordbook-model.ts, anki/fields.ts
import { SRS as SRS_CFG } from '../constants.js';
import { getNativeLang } from '../runtime.js';
import { currentChatId } from '../storage.js';
import { storeMode } from '../data-store.js';
import { writeUserFile } from '../user-files.js';
import { mediaExists, noteUploaded } from '../media-files.js';
import { loadWordbook, saveWordbook, getSets, createSet } from '../wordbook.js';
import { mergeWordbooks } from '../wordbook-model.js';
// ── Media ─────────────────────────────────────────────────────────────────────
const AUDIO = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'webm']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg']);
const extOf = (name) => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';
/** Whether a media file of this name can be kept (a known audio or image type). */
export const keepableMedia = (name, kind) => (kind === 'sound' ? AUDIO : IMAGE).has(extOf(name));
/** A 64-bit content fingerprint (two FNV-1a passes), as hex. */
export function bytesHash(bytes) {
    let a = 0x811c9dc5, b = 0x01000193 ^ bytes.length;
    for (let i = 0; i < bytes.length; i++) {
        a = Math.imul(a ^ bytes[i], 0x01000193);
        b = Math.imul(b ^ bytes[i], 0x5bd1e995) ^ (b >>> 15);
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
/** The user-files name for a media file's bytes. */
export const mediaFileName = (bytes, original) => `pg-media-${bytesHash(bytes)}.${extOf(original)}`;
/**
 * Stores the media the rows use; returns package name → stored name for the
 * files that made it. Runs a few uploads at a time.
 */
export async function storeMedia(names, read, onProgress, signal) {
    const stored = new Map();
    const written = [];
    let done = 0, failed = 0, next = 0;
    const worker = async () => {
        while (next < names.length && !signal?.aborted) {
            const name = names[next++];
            try {
                const bytes = await read(name);
                if (!bytes) {
                    failed++;
                    continue;
                }
                const file = mediaFileName(bytes, name);
                if (await mediaExists(file))
                    stored.set(name, file);
                else if (await writeUserFile(file, bytes, signal) === 'ok') {
                    stored.set(name, file);
                    written.push(file);
                }
                else
                    failed++;
            }
            catch {
                failed++;
            }
            finally {
                onProgress({ done: ++done, total: names.length });
            }
        }
    };
    await Promise.all([worker(), worker(), worker()]);
    // Accounted for at the next save: kept if the words using them are added, deleted otherwise
    noteUploaded(written);
    return { stored, failed };
}
/** Media files can be stored only while the wordbook lives in the user's files. */
export const canStoreMedia = () => storeMode() === 'file';
/** The media the rows refer to that can be kept. */
export function mediaOf(rows, available) {
    const names = new Set();
    for (const r of rows) {
        if (r.sound && available.has(r.sound) && keepableMedia(r.sound, 'sound'))
            names.add(r.sound);
        if (r.image && available.has(r.image) && keepableMedia(r.image, 'image'))
            names.add(r.image);
    }
    return [...names];
}
/** The set for a deck, reusing one of the same name (so a re-import lands in the same set). */
function setFor(deck, cache) {
    let id = cache.get(deck);
    if (!id) {
        id = getSets().find(s => s.name === deck)?.id ?? createSet(deck);
        cache.set(deck, id);
    }
    return id;
}
/** Adds the rows to the wordbook (and the open chat); `media` maps package names to stored files. */
export function addRows(rows, fallbackDeck, media) {
    const chatId = currentChatId();
    const lang = getNativeLang() || undefined;
    const now = new Date().toISOString();
    const sets = new Map();
    // Same word twice in the deck: the first note wins, the rest only add their sets
    const incoming = new Map();
    for (const r of rows) {
        const setId = setFor(r.deck || fallbackDeck, sets);
        const seen = incoming.get(r.word);
        if (seen) {
            if (!seen.setIds.includes(setId))
                seen.setIds.push(setId);
            continue;
        }
        incoming.set(r.word, {
            word: r.word,
            base_form: r.word,
            meaning: r.meaning,
            meaning_lang: lang,
            level: '',
            ...(r.reading && { reading: r.reading }),
            ...(r.example && { example: r.example }),
            ...(r.notes && { notes: r.notes }),
            ...(r.sound && media.has(r.sound) && { audio: media.get(r.sound) }),
            ...(r.image && media.has(r.image) && { image: media.get(r.image) }),
            setIds: [setId],
            chats: chatId ? [chatId] : [],
            dateAdded: now,
            srs_interval: SRS_CFG.initialInterval,
            srs_ease: SRS_CFG.defaultEase,
            srs_due: Date.now(),
        });
    }
    const { wordbook, added, merged } = mergeWordbooks(loadWordbook(), [...incoming.values()]);
    saveWordbook(wordbook);
    return { added, updated: merged, setIds: [...sets.values()] };
}
