// Chat metadata access. Where Polyglot keeps what:
//
//   user file       polyglot-data.json on the ST server       wordbook, sets, wrong answers (data-store.ts)
//   chat metadata   per chat, saved inside the chat file      annotations (and the wordbook on an ST
//                                                             without file storage)
//   settings        global, ST's settings.json                options only
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
