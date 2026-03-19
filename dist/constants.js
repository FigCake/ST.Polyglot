// ════════════════════════════
// Polyglot  constants.ts
// ════════════════════════════
// Single source of truth for every magic value used across the extension.
// Import what you need:
//   import { SEL, DELAY, SRS, CEFR_LEVELS } from './constants.js';
//
// Naming conventions:
//   SEL   — CSS / DOM selectors (ST internals and Polyglot elements)
//   ID    — bare HTML id strings (used where '#' prefix is not wanted)
//   KEY   — storage keys (extension_settings, chatMetadata, localStorage, IDB)
//   DELAY — timing values in milliseconds
//   Z     — z-index layers
//   SRS   — SM-2 spaced-repetition algorithm parameters
//   API   — network / provider defaults
//   UI    — miscellaneous UI limits and thresholds
// ── SillyTavern DOM selectors ─────────────────────────────────────────────────
// These mirror ST's internal HTML structure.  If ST ever renames these,
// only this file needs updating.
export const SEL = {
    // ST chat area
    chat: '#chat',
    mes: '.mes',
    mesText: '.mes_text',
    mesUser: '.mes[is_user="false"]',
    extraMesButtons: '.extraMesButtons',
    // ST UI chrome
    sendBtn: '#send_but',
    sendTextarea: '#send_textarea',
    extensionsMenu: '#extensionsMenu',
    extensionsList: '#extensions_settings',
    // Polyglot root elements (bare IDs — use with getElementById)
    snackbar: 'pg-snackbar',
    wandBtn: 'pg-wand-btn',
    extMenuBtn: 'pg-ext-menu-btn',
    settingsPanel: 'pg-settings-panel',
    learningPanel: 'pg-learning-panel',
    notiRack: 'pg-notis',
    // Polyglot panel IDs (used as panelId in PgPanel)
    learningPanelId: 'pg-learning-panel',
    // Polyglot per-message elements
    annotateBtn: '.pg-annotate-btn',
    clickableWord: '.pg-clickable-word',
    tapBubble: '.pg-tap-bubble',
    // Conjugation overlay
    conjOverlay: '.pg-conj-overlay',
    conjModal: '.pg-conj-modal',
    conjClose: '.pg-conj-close',
    conjBody: '.pg-conj-body',
    conjBase: '.pg-conj-base',
    conjMeaning: '.pg-conj-meaning',
    // Wordbook panel
    wbList: '#pg-wb-list',
    wbCount: '#pg-wb-count',
    wbSetSel: '#pg-wb-set-sel',
    wbSetNew: '#pg-wb-set-new',
    wbImport: '#pg-wb-import',
    wbExport: '#pg-wb-export',
    wbExportDropdown: '#pg-wb-export-dropdown',
    wbCsv: '#pg-wb-csv',
    wbTxt: '#pg-wb-txt',
    wbSelAll: '#pg-wb-sel-all',
    wbDelSel: '#pg-wb-del-sel',
    wbSelCount: '#pg-wb-sel-count',
    wbRowChk: '.pg-wb-row-chk',
    wbRowChkChecked: '.pg-wb-row-chk:checked',
    wbDel: '.pg-wb-del',
    wbConjBtn: '.pg-wb-conj-btn',
    wbCtxBtn: '.pg-wb-ctx-btn',
    setDel: '.pg-set-del',
    setManager: '#pg-set-manager',
    filterPill: '.pg-filter-pill',
    setCheckInput: '.pg-set-check input',
    // Detail / quiz panel
    btnRetry: '#pg-btn-retry',
    btnAddWord: '#pg-btn-add-word',
    btnAddGram: '#pg-btn-add-gram',
    btnStartQuiz: '#pg-btn-start-quiz',
    quizContainer: '#pg-quiz-container',
    speakBtn: '.pg-speak-btn',
    // Flashcard
    flashCard: '#pg-flash-card',
    // Tap bubble
    tapClose: '.pg-tap-close',
    tapConjBtn: '.pg-tap-conj-btn',
    tapSaveBtn: '.pg-tap-save-btn',
    tapSaveSentence: '.pg-tap-save-sentence',
    // Selection tooltip
    selBtn: '.pg-sel-btn',
    // Settings panel
    chkChecker: '#pg-chk-checker',
    chkAnnotator: '#pg-chk-annotator',
    selLang: '#pg-sel-lang',
    rowLangCustom: '#pg-row-lang-custom',
    inpLangCustom: '#pg-inp-lang-custom',
    selCefr: '#pg-sel-cefr',
    selProvider: '#pg-sel-provider',
    providerDetail: '#pg-provider-detail',
    rngTokens: '#pg-rng-tokens',
    numTokens: '#pg-num-tokens',
    tokensDisplay: '#pg-tokens-display',
    btnClearChat: '#pg-btn-clear-chat',
    btnClearAll: '#pg-btn-clear-all',
    btnClearConj: '#pg-btn-clear-conj',
    chkStOverride: '#pg-chk-st-override',
    stOverrideRows: '#pg-st-override-rows',
    inpRouteSource: '#pg-inp-route-source',
    inpRouteModel: '#pg-inp-route-model',
    stLiveSource: '#pg-st-live-source',
    selModel: '#pg-sel-model',
    rowModelCustom: '#pg-row-model-custom',
    inpModelCustom: '#pg-inp-model-custom',
    inpExtUrl: '#pg-inp-ext-url',
    inpExtKey: '#pg-inp-ext-key',
    inpExtModel: '#pg-inp-ext-model',
    navTab: '.pg-nav-tab',
    snackbarStop: '.pg-snackbar-stop',
    boxPane: '.pg-box-pane',
};
// ── Storage keys ───────────────────────────────────────────────────────────────
export const KEY = {
    // extension_settings namespace
    module: 'polyglot',
    // chatMetadata keys
    wordbook: 'pg_wordbook',
    annotations: 'pg_annotations',
    // IndexedDB — conjugation cache
    conjDB: 'pg_conj_cache',
    conjStore: 'tables',
    conjDBVersion: 1,
};
// ── Timing (milliseconds) ─────────────────────────────────────────────────────
export const DELAY = {
    /** One animation frame — minimum debounce / retry interval. */
    animFrame: 16,
    /** Delay before showing a tooltip or selection popup.
     *  Mobile browsers need extra time to finalise the selection range. */
    tooltipShow: 50,
    /** Long-press threshold for mobile tap-to-translate. */
    longPress: 500,
    /** Ghost-click suppression window after a long-press fires. */
    ghostClick: 300,
    /** Debounce window for chat-switch events before re-restoring annotations. */
    chatSwitch: 300,
    /** Maximum wall-clock time (ms) to keep retrying annotation restore. */
    restoreDeadline: 3_000,
    /** Delay before the ST extensions menu button is re-attached on SPA navigation. */
    menuReattach: 1_000,
    /** How long snackbar fade-out animation takes (must match CSS transition). */
    snackbarFadeOut: 250,
    /** Default duration for notify() toasts. */
    toastDefault: 3_000,
    /** Shorter duration for success/confirmation toasts. */
    toastShort: 2_500,
};
// ── Z-index layers ─────────────────────────────────────────────────────────────
// Keep all z-index values here so stacking order is auditable at a glance.
// ST's own overlays live around 9000–10000.
export const Z = {
    /** Dim backdrop for PgPanel modals. */
    dim: 10_100,
    /** Floating sidebar / learning panel. */
    sidebar: 10_000,
    /** Toast notification rack. */
    snackbar: 10_202,
    /** Selection tooltip. */
    tooltip: 10_201,
    /** Conjugation table modal (appears above the learning panel). */
    conjModal: 10_400,
    /** Future: syntax / annotation overlay (above message text). */
    overlay: 10_050,
};
// ── CEFR levels ────────────────────────────────────────────────────────────────
export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
/** All level values that can appear on a WordbookEntry.level field. */
export const ALL_LEVELS = [...CEFR_LEVELS, 'grammar', 'sentence', 'idiom'];
/** Wordbook filter pills (includes 'all' sentinel).
 *  'sentence' is intentionally excluded — sentence entries are reference material,
 *  not study targets, and clutter the default filter bar. */
export const LEVEL_FILTERS = ['all', ...CEFR_LEVELS, 'grammar', 'idiom'];
// ── Part-of-speech tags ────────────────────────────────────────────────────────
/** Canonical POS tag values stored on WordbookEntry.pos.
 *  Used for badge display and click-to-filter in the wordbook list.
 *  The AI reanalysis prompt is instructed to return exactly one of these. */
export const POS_TAGS = [
    'verb', 'noun', 'adj', 'adv', 'phrase',
    'particle', 'conj', 'prep', 'num', 'interj', 'article',
];
/** Human-readable short label for each POS tag.
 *  Shown inside the badge chip on wordbook rows.
 *  Keys must match POS_TAGS exactly. */
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
    /** Maximum number of chats whose annotations are kept in extension_settings.
     *  Oldest entries are evicted when this cap is exceeded. */
    annotationsCap: 50,
    /** Minimum touch target size in px (WCAG 2.5.5 AAA = 44px).
     *  Used when calculating tooltip / button placement. */
    minTouchTarget: 44,
    /** Tooltip horizontal margin from viewport edge (px). */
    tooltipEdgeMargin: 4,
    /** Maximum recent-history messages sent to quiz/checker prompts. */
    quizHistoryMessages: 6,
};
// ── SRS (SM-2 spaced-repetition) parameters ───────────────────────────────────
export const SRS = {
    /** One calendar day in milliseconds. */
    dayMs: 86_400_000,
    /** Default ease factor for new cards (Anki default). */
    defaultEase: 2.5,
    /** Absolute minimum ease factor — prevents cards from becoming unrecoverable. */
    minEase: 1.3,
    /** Starting interval for new cards (days). */
    initialInterval: 1,
    /** Ease penalty for "Again" (rating 0). */
    againEaseDelta: -0.20,
    /** Ease penalty for "Hard" (rating 1). */
    hardEaseDelta: -0.15,
    /** Interval multiplier for "Hard" (rating 1). */
    hardIntervalMult: 1.2,
    /** Interval bonus multiplier for "Easy" (rating 3). */
    easyIntervalBonus: 1.3,
};
// ── API / network defaults ─────────────────────────────────────────────────────
export const API = {
    /** Default max_tokens for model calls. */
    defaultMaxTokens: 30_000,
    /** Minimum allowed max_tokens in the settings slider. */
    minTokens: 500,
    /** Maximum allowed max_tokens in the settings slider. */
    maxTokens: 100_000,
    /** Token slider step size. */
    tokensStep: 500,
    /** System prompt sent before every JSON-returning model call. */
    sysJson: 'You are a precise language analysis assistant. Always respond with valid JSON only. No preamble, no markdown fences, no extra text.',
};
// ── Native-language tags ───────────────────────────────────────────────────────
// BCP-47 short tags for the supported UI / explanation languages.
// Used as the `meaning_lang` field on WordbookEntry and in prompt generation.
export const NATIVE_LANG_TAG = {
    Korean: 'ko',
    English: 'en',
    Italian: 'it',
    Spanish: 'es',
};
/** Human-readable language name used inside AI prompts. */
export const NATIVE_LANG_LABEL = {
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
// ── Syntax analysis ─────────────────────────────────────────────────────────────
/** Canonical role labels for syntax token analysis. */
export const SYNTAX_ROLES = ['subject', 'verb', 'object', 'complement', 'modifier', 'conjunction', 'particle'];
/**
 * Converts a stored native_lang tag ('ko'|'en'|'it'|'es'|'custom') into the
 * human-readable language name used inside AI prompts.
 *
 * @param tag     Value of Settings.native_lang
 * @param custom  Value of Settings.native_lang_custom (used when tag === 'custom')
 */
export function resolveNativeLang(tag, custom = '') {
    if (tag === 'custom')
        return custom.trim() || 'English';
    return NATIVE_LANG_LABEL[tag] ?? 'English';
}
/** i18n: supported UI language tags.  Add more here when translations are ready. */
export const UI_LANGS = ['ko', 'en', 'it', 'es'];
// ── External dictionary URLs ───────────────────────────────────────────────────
// Default dictionary URL per learning language.
// {word} is replaced with encodeURIComponent(base_form || word) at call time.
// Callers fall back to dict_url_custom from settings when the language is 'Custom'
// or has no entry here.
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
/**
 * Returns the dictionary URL for the given learning language,
 * with {word} replaced by the encoded word.
 *
 * Priority: custom URL from settings → language default → null
 */
export function dictUrl(lang, word, customUrl = '') {
    const encoded = encodeURIComponent(word.trim());
    const template = customUrl.trim() || DICT_URLS[lang] || null;
    if (!template)
        return null;
    return template.replace(/\{word\}/g, encoded);
}
