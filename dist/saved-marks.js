// Words being learnt, underlined in character messages without asking the AI.
//
//   refreshSavedMarks()      marks every character message on screen (after a load, a
//                            new message, a word saved or reviewed…); a message whose
//                            marked words did not change is left alone
//   knownWordsIn(text)       known words a message holds, so analysis can leave them out
//   isKnownWord(...forms)    a form belongs to a known word (analysis results drop it)
//   isLearningWord(...forms) a form belongs to a word being learnt
//   recordSeenForms(words)   forms an analysis met learnt or saved words in, kept on them
//   countEncounters(mesId)   a new message met these learnt words: their count goes up
//
// Which words: only those being learnt (wordStatus 'learning': reviewed, not yet
// known). New words — say, thousands imported from an Anki deck and not reviewed
// yet — and known words are not marked. Names and "other words" never are.
//
// The marks are the 'saved' layer of ui/message-decor.ts, above the analysis
// highlights: a highlighted word that is being learnt keeps its highlight span
// (its card has this sentence's meaning) and gets the underline style instead
// of its level colour, so a word carries one mark only.
//
// Words are found by word-forms.ts from what is already stored: their forms,
// forms met in earlier analyses, and conjugation tables opened before (read from
// the browser cache; reread when it changes).
import { DECOR_CLASS, setLayer, hasLayer, messagesWith, resetLayers } from './ui/message-decor.js';
import { ST_SEL, mesIdOf, mesTextOf } from './st-dom.js';
import { scopedWordbook, loadWordbook, saveWordbook } from './wordbook.js';
import { wordStatus } from './srs.js';
import { formsOf, FormIndex, withSeenForm } from './word-forms.js';
import { getAllConjEntries, conjCacheVersion } from './conj-cache.js';
import { skippedNodes, wordSkipper } from './study-scope.js';
import { plainText } from './plain-text.js';
import { getSettings, getLang } from './runtime.js';
import { fnv1a } from './hash.js';
let openPanel = () => { };
/** The panel opener (injected: the panel layer imports modules that import this one). */
export function setSavedMarksPanelFn(fn) { openPanel = fn; }
const MARK_CLASS = 'pg-saved-mark';
/** Added to an analysis highlight whose word is being learnt. */
const ON_HIGHLIGHT = 'pg-saved-word';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'RUBY', 'RT', 'RP']);
const enabled = () => getSettings().mark_saved_words !== false;
const norm = (s) => (s ?? '').normalize('NFKC').toLowerCase().trim();
let cached = null;
/** The data changed since the index was built (a review, a saved or edited word…). */
let stale = true;
/** Conjugation tables of the study language by base form, and the cache version they were read at. */
let conj = new Map();
let conjRead = null;
let conjReading = null;
/** The data changed: the next lookup checks the words again (data-store.onDataChanged). */
export function savedWordsChanged() {
    stale = true;
}
/** Rereads the conjugation tables when the cache or the study language changed (then marks again). */
function readConjugations() {
    const lang = getLang();
    if (conjReading || (conjRead && conjRead.version === conjCacheVersion() && conjRead.lang === lang))
        return;
    const version = conjCacheVersion();
    conjReading = getAllConjEntries(lang)
        .then(entries => {
        conj = new Map(entries.map(e => [norm(e.word), e.data]));
        conjRead = { version, lang };
    })
        .catch(() => { conjRead = { version, lang }; })
        .finally(() => { conjReading = null; stale = true; refreshSavedMarks(); });
}
/**
 * The words of the study language with their forms. Checked again only after
 * the data changed; the form index is rebuilt only when a form-bearing field
 * did (a review changes the status, read live from the entries, not the forms).
 */
function index() {
    if (cached && !stale && cached.key.startsWith(`${getLang()}|`))
        return cached;
    const words = scopedWordbook('all');
    const fingerprint = fnv1a(words.map(e => [e.word, e.base_form, e.original_form, e.example_form, e.reading, ...(e.forms ?? [])].join('\u0001')).join('\u0002'));
    const key = `${getLang()}|${conjRead?.version ?? -1}|${words.length}|${fingerprint}`;
    const byWord = new Map(words.map(e => [e.word, e]));
    const forms = cached?.key === key ? cached.forms
        : new FormIndex(words.map(e => ({ word: e.word, forms: formsOf(e, conj.get(norm(e.base_form)) ?? conj.get(norm(e.word))) })));
    cached = { key, forms, byWord };
    stale = false;
    return cached;
}
const statusOf = (ix, word) => {
    const e = word ? ix.byWord.get(word) : undefined;
    return e ? wordStatus(e) : null;
};
// ── Drawing ───────────────────────────────────────────────────────────────────
function textNodesIn(root, skipped) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: n => n instanceof Element && (SKIP_TAGS.has(n.tagName) || n.classList.contains('pg-clickable-word') || n.matches('.pg-tap-bubble'))
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode())
        if (n instanceof Text && !skipped.has(n))
            nodes.push(n);
    return nodes;
}
/** A word's card as the learn tab shows it. */
function cardOf(e) {
    const data = {
        word: e.word, base_form: e.base_form, meaning: e.meaning, level: e.level,
        pos_info: e.pos_info ?? '', context_meaning: e.context_meaning ?? '',
        ...(e.reading && { reading: e.reading }),
    };
    return { type: 'word', data };
}
function markSpan(text, word) {
    const span = document.createElement('span');
    span.className = `${MARK_CLASS} ${DECOR_CLASS}`;
    span.textContent = text;
    span.dataset.word = word;
    span.addEventListener('click', () => {
        const e = loadWordbook().find(w => w.word === word);
        if (e)
            openPanel('learn', cardOf(e));
    });
    return span;
}
/** Learning-word matches in a text, names and "other words" left out. */
function learningMatches(ix, text, skip) {
    return ix.forms.find(text).filter(m => statusOf(ix, m.word) === 'learning' && !skip(text.slice(m.start, m.end), m.word));
}
function draw(textEl) {
    const ix = index();
    const skip = wordSkipper();
    for (const node of textNodesIn(textEl, skippedNodes(textEl))) {
        const text = node.data;
        const matches = learningMatches(ix, text, skip);
        if (!matches.length)
            continue;
        const frag = document.createDocumentFragment();
        let at = 0;
        for (const m of matches) {
            if (m.start > at)
                frag.append(text.slice(at, m.start));
            frag.append(markSpan(text.slice(m.start, m.end), m.word));
            at = m.end;
        }
        if (at < text.length)
            frag.append(text.slice(at));
        node.replaceWith(frag);
    }
    // Analysis highlights of words being learnt: one mark, the underline
    textEl.querySelectorAll('.pg-clickable-word').forEach(span => {
        if (statusOf(ix, ix.forms.wordOf(span.textContent ?? '')) === 'learning')
            span.classList.add(ON_HIGHLIGHT);
    });
}
function strip(textEl) {
    textEl.querySelectorAll(`.${MARK_CLASS}`).forEach(span => span.replaceWith(span.textContent ?? ''));
    textEl.querySelectorAll(`.${ON_HIGHLIGHT}`).forEach(span => span.classList.remove(ON_HIGHLIGHT));
    textEl.normalize();
}
const DECORATION = { draw, strip };
/** What each message was last marked with, so an unchanged message is not redrawn. */
const marked = new Map();
/** The learning words a message shows (in its plain text, skipped parts left out), as a sorted key. */
function markKey(ix, textEl, skip) {
    const words = new Set();
    for (const node of textNodesIn(textEl, skippedNodes(textEl))) {
        for (const m of learningMatches(ix, node.data, skip))
            words.add(m.word);
    }
    textEl.querySelectorAll('.pg-clickable-word').forEach(span => {
        const word = ix.forms.wordOf(span.textContent ?? '');
        if (word && statusOf(ix, word) === 'learning')
            words.add(`~${word}`);
    });
    return [...words].sort().join('\u0001');
}
/** Marks the learning words in every character message on screen, or in the given ones. */
export function refreshSavedMarks(mesIds) {
    if (!enabled()) {
        clearSavedMarks();
        return;
    }
    readConjugations();
    const ix = index();
    const skip = wordSkipper();
    const ids = mesIds ?? [...document.querySelectorAll(ST_SEL.aiMes)].map(el => mesIdOf(el)).filter((id) => !!id);
    for (const mesId of ids) {
        const textEl = mesTextOf(mesId);
        if (!textEl || textEl.closest(ST_SEL.mes)?.getAttribute('is_user') === 'true')
            continue;
        // Read with the marks taken off (they wrap text, so the text is the same either way)
        const key = markKey(ix, textEl, skip);
        if (marked.get(mesId) === key && (hasLayer(mesId, 'saved') || !key))
            continue;
        marked.set(mesId, key);
        setLayer(mesId, 'saved', key ? DECORATION : null);
    }
}
/** Takes every mark down (the setting was turned off). */
export function clearSavedMarks() {
    for (const mesId of messagesWith('saved'))
        setLayer(mesId, 'saved', null);
    marked.clear();
}
/** Forgets what was marked (chat switch: the messages are new). */
export function resetSavedMarks() {
    marked.clear();
    resetLayers('saved');
}
// ── Analysis ──────────────────────────────────────────────────────────────────
/** Known words in a text as they appear in it (at most `limit`), for the analysis to leave out. */
export function knownWordsIn(text, limit = 60) {
    const ix = index();
    const out = new Set();
    for (const m of ix.forms.find(text)) {
        if (statusOf(ix, m.word) === 'known')
            out.add(text.slice(m.start, m.end));
        if (out.size >= limit)
            break;
    }
    return [...out];
}
const isStatus = (status) => (...forms) => {
    const ix = index();
    return forms.some(f => statusOf(ix, ix.forms.wordOf(f)) === status);
};
export const isKnownWord = isStatus('known');
export const isLearningWord = isStatus('learning');
/**
 * Keeps the forms an analysis met saved words in ("parlavo" for parlare), so
 * they are found without the AI next time. Known words are not analysed, so
 * they gain none.
 */
export function recordSeenForms(found) {
    const ix = index();
    const wordbook = loadWordbook();
    const byWord = new Map(wordbook.map(e => [e.word, e]));
    let changed = false;
    for (const { word, base_form } of found) {
        if (!word?.trim())
            continue;
        const target = byWord.get(ix.forms.wordOf(word) ?? '') ?? byWord.get(ix.forms.wordOf(base_form) ?? '')
            ?? wordbook.find(e => norm(e.base_form) === norm(base_form));
        if (!target || formsOf(target).includes(norm(word)))
            continue;
        target.forms = withSeenForm(target.forms, word);
        changed = true;
    }
    if (changed)
        saveWordbook(wordbook, true);
}
// ── Encounters ────────────────────────────────────────────────────────────────
/** Words already counted per message in this session (a continued message is not counted twice). */
const counted = new Map();
/** A new character message met these words being learnt: each counts once per message. */
export function countEncounters(mesId) {
    const textEl = mesTextOf(mesId);
    if (!textEl || textEl.closest(ST_SEL.mes)?.getAttribute('is_user') === 'true')
        return;
    const ix = index();
    const skip = wordSkipper();
    const words = new Set(learningMatches(ix, plainText(textEl), skip).map(m => m.word));
    const done = counted.get(mesId) ?? new Set();
    const fresh = [...words].filter(w => !done.has(w));
    if (!fresh.length)
        return;
    fresh.forEach(w => done.add(w));
    counted.set(mesId, done);
    const wordbook = loadWordbook();
    for (const e of wordbook)
        if (fresh.includes(e.word))
            e.seen = (e.seen ?? 0) + 1;
    saveWordbook(wordbook, true);
}
/** Forgets which messages were counted (chat switch). */
export function resetEncounters() {
    counted.clear();
}
