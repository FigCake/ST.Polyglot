// Puts Anki rows into the wordbook, with their media.
//
//   rows ─▶ media used by the rows ─▶ user files  pg-media-<hash>.<ext>
//        ─▶ entries (one set per deck) ─▶ merged into the wordbook
//
// Media files are named by their content, so importing the same deck again
// (or two decks sharing a file) stores each file once; a file already on the
// server is not uploaded again. Existing words keep their text: an import
// only fills what is empty and adds the word to the deck's set.
import { SRS as SRS_CFG } from '../constants.js';
import { getNativeLang } from '../runtime.js';
import { currentChatId } from '../storage.js';
import { storeMode } from '../data-store.js';
import { writeUserFile } from '../user-files.js';
import { existingMedia, inParallel, keepableMedia, noteUploaded } from '../media-files.js';
import { loadWordbook, saveWordbook, getSets, createSet } from '../wordbook.js';
import { mergeWordbooks } from '../wordbook-model.js';
// ── Media ─────────────────────────────────────────────────────────────────────
const extOf = (name) => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';
export { keepableMedia };
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
/** Files read, named and checked together: bounds memory and the size of each existence check. */
const MEDIA_BATCH = 200;
/** Uploads running at once (browsers allow about six connections per server). */
const UPLOADS_AT_ONCE = 6;
/**
 * Stores the media the rows use; returns package name → stored name for the
 * files that made it. Works through the files in batches: read and name a
 * batch, ask the server once which of them it has, upload the rest a few at
 * a time.
 */
export async function storeMedia(names, read, onProgress, signal) {
    const stored = new Map();
    const written = new Set();
    let done = 0, failed = 0;
    const tick = () => onProgress({ done: ++done, total: names.length });
    for (let i = 0; i < names.length && !signal?.aborted; i += MEDIA_BATCH) {
        const files = new Map();
        for (const name of names.slice(i, i + MEDIA_BATCH)) {
            const bytes = await read(name).catch(() => null);
            if (bytes)
                files.set(name, { file: mediaFileName(bytes, name), bytes });
            else {
                failed++;
                tick();
            }
        }
        const unique = [...new Set([...files.values()].map(f => f.file))].filter(f => !written.has(f));
        const present = await existingMedia(unique);
        const toUpload = [];
        for (const entry of files) {
            const [name, { file }] = entry;
            if (present.has(file) || written.has(file)) {
                stored.set(name, file);
                tick();
            }
            else
                toUpload.push(entry);
        }
        // Two package names with the same content upload once
        const uploads = new Map();
        await inParallel(toUpload, UPLOADS_AT_ONCE, async ([name, { file, bytes }]) => {
            if (signal?.aborted)
                return;
            let upload = uploads.get(file);
            if (!upload) {
                upload = writeUserFile(file, bytes, signal).then(r => r === 'ok', () => false);
                uploads.set(file, upload);
            }
            if (await upload) {
                stored.set(name, file);
                written.add(file);
            }
            else
                failed++;
            tick();
        });
    }
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
