// Shared values used across the extension. SillyTavern's DOM selectors are
// in st-dom.ts.
//   KEY   — storage keys (extension_settings, chatMetadata, localStorage, IndexedDB)
//   DELAY — timing values in milliseconds
//   UI    — miscellaneous UI limits
// ── Storage keys ───────────────────────────────────────────────────────────────
export const KEY = {
    // extension_settings namespace
    module: 'polyglot',
    // chatMetadata keys
    wordbook: 'pg_wordbook',
    annotations: 'pg_annotations',
    furigana: 'pg_furigana',
    translations: 'pg_translations',
    // localStorage — media uploads no save has accounted for yet (media-files.ts)
    mediaPending: 'pg_media_pending',
    // IndexedDB — conjugation cache
    conjDB: 'pg_conj_cache',
    conjStore: 'tables',
    conjDBVersion: 1,
    // IndexedDB — changes not yet saved to the data file (save-journal.ts)
    journalDB: 'pg_save_journal',
    journalStore: 'pending',
};
// ── Timing (milliseconds) ─────────────────────────────────────────────────────
export const DELAY = {
    /** One animation frame; the retry interval for annotation restore. */
    animFrame: 16,
    /** Before showing the selection tooltip: mobile browsers finalise the selection late. */
    tooltipShow: 50,
    /** After a chat switch, so ST can render the new chat before annotations are restored. */
    chatSwitch: 300,
    /** How long to keep retrying annotation restore. */
    restoreDeadline: 3_000,
    /** Second try at binding to #chat, which may not exist at startup. */
    menuReattach: 1_000,
    /** Must match the CSS fade-out transition. */
    snackbarFadeOut: 250,
};
// ── CEFR levels ────────────────────────────────────────────────────────────────
export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
/** Wordbook level filters, with the 'all' sentinel. */
export const LEVEL_FILTERS = ['all', ...CEFR_LEVELS, 'grammar', 'idiom'];
// ── Part-of-speech tags ────────────────────────────────────────────────────────
/** Values of WordbookEntry.pos. The reanalysis prompt must return exactly one of these. */
export const POS_TAGS = [
    'verb', 'noun', 'adj', 'adv', 'phrase',
    'particle', 'conj', 'prep', 'num', 'interj', 'article',
];
/** Short badge label for each POS tag on wordbook rows. */
export const POS_LABELS = {
    verb: 'V',
    noun: 'N',
    adj: 'Adj',
    adv: 'Adv',
    phrase: 'Phr',
    particle: 'Ptcl',
    conj: 'Conj',
    prep: 'Prep',
    num: 'Num',
    interj: 'Interj',
    article: 'Art',
};
// ── UI limits ─────────────────────────────────────────────────────────────────
export const UI = {
    /** Recent chat messages sent with a quiz prompt. */
    quizHistoryMessages: 6,
};
/** Human-readable language name used inside AI prompts. */
const NATIVE_LANG_LABEL = {
    ko: 'Korean',
    en: 'English',
    it: 'Italian',
    es: 'Spanish',
};
// ── Quiz types ─────────────────────────────────────────────────────────────────
export const QUIZ_TYPE_LABELS = {
    vocab: 'Vocab',
    verb: 'Verb',
    grammar: 'Grammar',
    idiom: 'Idiom',
    reading: 'Reading',
};
/** Turns Settings.native_lang (plus native_lang_custom for 'custom') into the name used in prompts. */
export function resolveNativeLang(tag, custom = '') {
    if (tag === 'custom')
        return custom.trim() || 'English';
    return NATIVE_LANG_LABEL[tag] ?? 'English';
}
// ── External dictionary URLs ───────────────────────────────────────────────────
// Default dictionary URL per learning language; {word} becomes the encoded word.
// A custom URL from settings takes priority (see dictUrl).
export const DICT_URLS = {
    English: 'https://www.merriam-webster.com/dictionary/{word}',
    Spanish: 'https://dle.rae.es/{word}',
    Italian: 'https://www.treccani.it/vocabolario/{word}',
    French: 'https://www.cnrtl.fr/definition/{word}',
    German: 'https://www.dwds.de/wb/{word}',
    Japanese: 'https://jisho.org/search/{word}',
    Chinese: 'https://www.mdbg.net/chinese/dictionary?wdqb={word}',
    Korean: 'https://dict.naver.com/search.nhn?dicQuery={word}',
};
/** Dictionary URL for a word. Priority: custom URL from settings → language default → null. */
export function dictUrl(lang, word, customUrl = '') {
    const encoded = encodeURIComponent(word.trim());
    const custom = customUrl.trim();
    // Only web links: a javascript: URL in settings would run when clicked
    const template = (/^https?:\/\//i.test(custom) ? custom : '') || DICT_URLS[lang] || null;
    if (!template)
        return null;
    return template.replace(/\{word\}/g, encoded);
}
