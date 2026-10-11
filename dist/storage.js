// Chat metadata access. Where Polyglot keeps what:
//
//   user files      on the ST server                          polyglot-data.json: wordbook, sets, wrong answers,
//                                                             correction archive (data-store.ts); words' sounds
//                                                             and pictures (media-files.ts)
//   chat metadata   per chat, saved inside the chat file      analyses and readings by message (and the wordbook
//                                                             on an ST without file storage)
//   settings        global, ST's settings.json                options (and, without file storage, sets, wrong
//                                                             answers and the correction archive)
//   localStorage    per browser                               media uploads no save has accounted for yet
//   IndexedDB       per browser                               conjugation tables (conj-cache.ts) — a cache
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { getContext, saveMetadataDebounced } from '../../../../extensions.js';
/** Null when no chat is loaded. */
export function chatMetadata() {
    return getContext()?.chatMetadata ?? null;
}
/** Schedules a metadata save. Older ST builds expose it only on the context. */
export function saveChatMetadata() {
    if (typeof saveMetadataDebounced === 'function') {
        saveMetadataDebounced();
        return;
    }
    const ctx = getContext();
    if (typeof ctx?.saveMetadata === 'function')
        ctx.saveMetadata();
    else if (typeof ctx?.saveMetadataDebounced === 'function')
        ctx.saveMetadataDebounced();
}
export function chatValue(key) {
    return {
        get() {
            return chatMetadata()?.[key];
        },
        /** Returns false when no chat is loaded (nothing was written). */
        set(value) {
            const meta = chatMetadata();
            if (!meta)
                return false;
            meta[key] = value;
            saveChatMetadata();
            return true;
        },
        delete() {
            const meta = chatMetadata();
            if (!meta || !(key in meta))
                return;
            delete meta[key];
            saveChatMetadata();
        },
    };
}
/** Stable id of the open chat, used to detect chat switches during async work. */
export function currentChatId() {
    return getContext()?.chatId ?? null;
}
