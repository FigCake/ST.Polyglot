// Pure wordbook operations: chat and language tags, scope, merging, per-chat overview.
//
// One shared wordbook holds every entry. `entry.chats` lists the chats the
// word was collected in; an entry with no chats is "unsorted" (saved while no
// chat was open, or from an old global wordbook). The UI shows either the
// open chat's words or all of them (WordbookScope). `entry.langs` lists the
// study languages it was saved under in the same way; an entry without one
// (saved before languages were recorded) shows in every language.
//
// No DOM, no storage — unit-tested.
import { langKey } from './utils.js';
import { FORMS_KEPT } from './word-forms.js';
import { mergeSounds, renamedSounds, withExampleOf, withMadeList, EXAMPLE_FIELDS } from './word-sounds.js';
/** Key of the "no chat" group in overviews and chat selections. */
export const UNSORTED = '';
export const chatsOf = (e) => e.chats ?? [];
/** Whether the entry is visible in `scope` (with no chat open, "chat" shows everything). */
export function inScope(e, scope, chatId) {
    return scope === 'all' || !chatId || chatsOf(e).includes(chatId);
}
export const langsOf = (e) => e.langs ?? [];
export { langKey };
/** Whether the entry belongs to study language `lang` (no filter: null; no recorded language: every one). */
export const inLang = (e, lang) => !lang || !langsOf(e).length || langsOf(e).includes(lang);
/** Group key of each chat the entry belongs to (UNSORTED when it has none). */
const groupsOf = (e) => (chatsOf(e).length ? chatsOf(e) : [UNSORTED]);
// ── Tags ──────────────────────────────────────────────────────────────────────
function union(a = [], b = []) {
    return [...new Set([...a, ...b])];
}
/** Adds a chat tag; returns true when it was missing. */
export function tagChat(e, chatId) {
    if (!chatId || chatsOf(e).includes(chatId))
        return false;
    e.chats = [...chatsOf(e), chatId];
    return true;
}
/** Adds a study-language tag; returns true when it was missing. */
export function tagLang(e, lang) {
    if (!lang || langsOf(e).includes(lang))
        return false;
    e.langs = [...langsOf(e), lang];
    return true;
}
// ── Merging ───────────────────────────────────────────────────────────────────
/** The last thing done to the word's schedule (a review, or a reset after it) and the interval it left. */
function progressOf(e) {
    const reviewed = e.srs_reviewed_at ?? 0, reset = e.srs_reset_at ?? 0;
    return reset > reviewed ? [reset, 0] : [reviewed, e.srs_stability ?? e.srs_interval ?? 0];
}
/** True when `a` has seen more review than `b` (latest review or reset first, then longest interval). */
function moreReviewed(a, b) {
    const [ra, ia] = progressOf(a), [rb, ib] = progressOf(b);
    return ra !== rb ? ra > rb : ia >= ib;
}
function joinNotes(a, b) {
    if (!a || !b || a === b)
        return a || b || undefined;
    return a.includes(b) ? a : b.includes(a) ? b : `${a}\n${b}`;
}
const earliest = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
/**
 * Combines two entries for the same word. `a` is the one kept (its text wins
 * where both have a value); lists are united, notes joined, and the SRS state
 * of whichever copy was reviewed more is kept.
 */
export function mergeEntries(a, b) {
    const srs = moreReviewed(a, b) ? a : b;
    const merged = { ...b, ...stripEmpty(a) };
    // The schedule comes whole from one copy, never mixed
    for (const k of SRS_FIELDS)
        delete merged[k];
    return mergeSounds(a, b, {
        ...merged,
        setIds: union(a.setIds, b.setIds),
        chats: union(a.chats, b.chats),
        langs: union(a.langs, b.langs),
        collocations: a.collocations?.length ? a.collocations : b.collocations,
        ...(a.forms || b.forms) && { forms: union(a.forms, b.forms).slice(-FORMS_KEPT) },
        ...(a.seen || b.seen) && { seen: Math.max(a.seen ?? 0, b.seen ?? 0) },
        notes: joinNotes(a.notes, b.notes),
        dateAdded: earliest(a.dateAdded, b.dateAdded),
        conj_cached: !!(a.conj_cached || b.conj_cached),
        ...srsOf(srs),
    });
}
/** The review schedule fields, which always move together (FSRS, the older SM-2 ones, and when it was reset). */
export const SRS_FIELDS = ['srs_stability', 'srs_difficulty', 'srs_due', 'srs_reviewed_at', 'srs_lapses',
    'srs_interval', 'srs_ease', 'srs_streak', 'srs_reset_at'];
/** An entry's schedule fields that are set. */
function srsOf(e) {
    const out = {};
    for (const k of SRS_FIELDS)
        if (e[k] !== undefined)
            out[k] = e[k];
    return out;
}
const LIST_FIELDS = new Set(['setIds', 'chats', 'langs', 'made_sounds', 'forms', 'renamed_from']);
/** Earlier spellings a word remembers. */
const RENAMES_KEPT = 3;
/**
 * `target` with the review schedule of `source` when `source` was reviewed
 * more (the schedule moves whole). A word renamed on one device and reviewed
 * under its old spelling on another keeps that review.
 */
export function withReviewsOf(target, source) {
    if (!moreReviewed(source, target) || JSON.stringify(srsOf(source)) === JSON.stringify(srsOf(target)))
        return target;
    const out = { ...target };
    for (const k of SRS_FIELDS)
        delete out[k];
    return { ...out, ...srsOf(source) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A list after both sides' additions and removals since `base`. */
function rebaseList(base = [], local = [], server = []) {
    const removed = (x) => base.includes(x) && (!local.includes(x) || !server.includes(x));
    return union(local, server).filter(x => !removed(x));
}
/**
 * An entry both devices changed since `base`, field by field: a field only
 * one side changed takes that change; lists get both sides' additions and
 * removals; notes are joined; other text changed on both sides keeps this
 * device's (`local`). The SRS state moves as one, from the side that
 * reviewed the word (both: the one reviewed more), so it is never a mix; so
 * does the example with its translation and sound, from the side that changed it.
 */
export function rebaseEntry(base, local, server) {
    const b = base;
    const l = local;
    const r = server;
    const reviewed = (e) => SRS_FIELDS.some(k => !same(e[k], b[k]));
    const srs = !reviewed(l) ? r : !reviewed(r) ? l : moreReviewed(local, server) ? l : r;
    const out = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        let v;
        if (SRS_FIELDS.includes(k))
            v = srs[k];
        else if (same(l[k], b[k]))
            v = r[k];
        else if (same(r[k], b[k]))
            v = l[k];
        else if (LIST_FIELDS.has(k))
            v = rebaseList(b[k], l[k], r[k]);
        else if (k === 'notes')
            v = joinNotes(l[k], r[k]);
        // Met on both devices: the larger count (each counted its own messages)
        else if (k === 'seen')
            v = Math.max(Number(l[k]) || 0, Number(r[k]) || 0);
        else
            v = l[k];
        if (v !== undefined)
            out[k] = v;
    }
    // The side that changed the example text wins; a sound alone decides only when neither did
    const textChanged = (e) => !same(e.example, b.example);
    const groupChanged = (e) => EXAMPLE_FIELDS.some(k => !same(e[k], b[k]));
    const exampleFrom = textChanged(l) ? local : textChanged(r) ? server : groupChanged(l) ? local : server;
    const merged = withExampleOf(out, exampleFrom);
    return withMadeList(merged, merged.made_sounds ?? []);
}
/** Fields that change without the learner editing the word: reviews, the conjugation flag, chat and language tags, forms met, times met. */
const UPKEEP_FIELDS = new Set([...SRS_FIELDS, 'conj_cached', 'chats', 'langs', 'forms', 'seen']);
/**
 * A word this session still has but another device deleted since `base`:
 * gone, unless the learner edited it here (a review, a tag or a sound a voice
 * service made does not bring a deleted word back). A word kept loses the sound or picture it had at
 * `base` when no word on the server uses it: the other device deleted the file.
 */
export function keptAfterDeletion(base, local, serverMedia) {
    const b = base;
    const l = local;
    const made = new Set(local.made_sounds ?? []);
    // A 🔊 press or a run that stored a made sound is upkeep too, not an edit
    const upkeep = (k) => UPKEEP_FIELDS.has(k) || k === 'made_sounds'
        || ((k === 'audio' || k === 'example_audio') && made.has(l[k]));
    const edited = [...new Set([...Object.keys(b), ...Object.keys(l)])].some(k => !upkeep(k) && !same(l[k], b[k]));
    if (!edited)
        return null;
    const out = { ...local };
    if (out.audio && out.audio === base.audio && !serverMedia.has(out.audio))
        delete out.audio;
    if (out.example_audio && out.example_audio === base.example_audio && !serverMedia.has(out.example_audio))
        delete out.example_audio;
    if (out.image && out.image === base.image && !serverMedia.has(out.image))
        delete out.image;
    return out;
}
/** Removes undefined / empty-string fields so they do not override the other copy when spread. */
function stripEmpty(e) {
    return Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined && v !== ''));
}
/** Adds `incoming` to `base` (same word → mergeEntries). Order: base first, then new words. */
export function mergeWordbooks(base, incoming) {
    const byWord = new Map(base.map(e => [e.word, e]));
    let added = 0, merged = 0;
    for (const e of incoming) {
        if (!e?.word)
            continue;
        const existing = byWord.get(e.word);
        if (existing) {
            byWord.set(e.word, mergeEntries(existing, e));
            merged++;
        }
        else {
            byWord.set(e.word, e);
            added++;
        }
    }
    return { wordbook: [...byWord.values()], added, merged };
}
/**
 * Removes the given chats' membership. An entry that belonged only to those
 * chats is deleted; one that is also in another chat stays there.
 * UNSORTED in `chatIds` selects entries without chats.
 */
export function removeChats(wordbook, chatIds, words) {
    const doomed = new Set(chatIds);
    const deleted = [];
    const kept = wordbook.flatMap(e => {
        if (words && !words.has(e.word))
            return [e];
        const groups = groupsOf(e);
        if (!groups.some(g => doomed.has(g)))
            return [e];
        const remaining = chatsOf(e).filter(c => !doomed.has(c));
        if (!remaining.length) {
            deleted.push(e.word);
            return [];
        }
        return [{ ...e, chats: remaining }];
    });
    return { wordbook: kept, deleted };
}
/** Deletes words outright. */
export function removeWords(wordbook, words) {
    return {
        wordbook: wordbook.filter(e => !words.has(e.word)),
        deleted: wordbook.filter(e => words.has(e.word)).map(e => e.word),
    };
}
/** Re-tags every entry of the given chats (or unsorted) as belonging to `target` instead. */
export function moveChats(wordbook, chatIds, target) {
    const from = new Set(chatIds);
    let moved = 0;
    const next = wordbook.map(e => {
        if (!groupsOf(e).some(g => from.has(g)))
            return e;
        moved++;
        return { ...e, chats: union(chatsOf(e).filter(c => !from.has(c)), [target]) };
    });
    return { wordbook: next, moved };
}
/** Word count per chat (an entry in two chats counts in both), largest first, UNSORTED last. */
export function chatOverview(wordbook) {
    const counts = new Map();
    for (const e of wordbook)
        for (const g of groupsOf(e))
            counts.set(g, (counts.get(g) ?? 0) + 1);
    return [...counts]
        .map(([chatId, count]) => ({ chatId, count }))
        .sort((a, b) => (a.chatId === UNSORTED ? 1 : b.chatId === UNSORTED ? -1 : b.count - a.count));
}
// ── Duplicates ────────────────────────────────────────────────────────────────
/** Comparison key: Unicode-normalised, case- and spacing-insensitive. */
export const wordKey = (s) => (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
/**
 * Groups of entries that are the same word: equal keys ("Casa" / "casa "),
 * or one entry's base form is another's word ("andato" → "andare").
 * Grammar patterns and sentences are left out. Each group lists the entry
 * to keep first: the one whose word others point to, else the most reviewed.
 */
export function findDuplicates(wordbook) {
    const items = wordbook.filter(e => e.level !== 'grammar' && e.level !== 'sentence');
    const parent = items.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const byWord = new Map();
    items.forEach((e, i) => {
        const key = wordKey(e.word);
        const seen = byWord.get(key);
        if (seen === undefined)
            byWord.set(key, i);
        else
            parent[find(i)] = find(seen);
    });
    items.forEach((e, i) => {
        const base = byWord.get(wordKey(e.base_form));
        if (base !== undefined)
            parent[find(i)] = find(base);
    });
    const groups = new Map();
    items.forEach((e, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), e]));
    const pointedAt = (e, group) => group.some(o => o !== e && wordKey(o.base_form) === wordKey(e.word));
    return [...groups.values()]
        .filter(g => g.length > 1)
        .map(g => [...g].sort((a, b) => Number(pointedAt(b, g)) - Number(pointedAt(a, g)) ||
        Number(moreReviewed(b, a)) - Number(moreReviewed(a, b))));
}
/** Folds the given words into the first one. Returns the new wordbook and the removed words. */
export function mergeGroup(wordbook, words) {
    const [keep, ...rest] = words;
    const target = wordbook.find(e => e.word === keep);
    const others = rest.map(w => wordbook.find(e => e.word === w)).filter((e) => !!e && e !== target);
    if (!target || !others.length)
        return { wordbook, removed: [] };
    // mergeEntries keeps the first argument's text; the kept entry's word stays the key
    const merged = others.reduce((acc, o) => ({ ...mergeEntries(acc, o), word: target.word }), target);
    const gone = new Set(others.map(o => o.word));
    return {
        wordbook: wordbook.filter(e => !gone.has(e.word)).map(e => (e === target ? merged : e)),
        removed: [...gone],
    };
}
/** Applies an edit; renaming onto an existing word merges the two (the edited one's text wins). */
export function editEntry(wordbook, word, patch) {
    const entry = wordbook.find(e => e.word === word);
    if (!entry)
        return { wordbook, word, merged: false, formChanged: false };
    const clean = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    const nextWord = clean.word || entry.word;
    // A made sound of the old spelling does not come along (a recording does)
    const edited = renamedSounds({ ...entry, ...clean, word: nextWord, base_form: clean.base_form || nextWord }, entry.word);
    // Another device may review it under the old spelling before it hears of the rename (user-data rebase)
    if (nextWord !== entry.word)
        edited.renamed_from = [...new Set([...(entry.renamed_from ?? []), entry.word])].filter(w => w !== nextWord).slice(-RENAMES_KEPT);
    const formChanged = edited.word !== entry.word || edited.base_form !== entry.base_form;
    if (formChanged)
        edited.conj_cached = false;
    const clash = nextWord !== word ? wordbook.find(e => e.word === nextWord) : undefined;
    if (clash) {
        const merged = { ...mergeEntries(edited, clash), word: nextWord };
        return {
            wordbook: wordbook.filter(e => e !== entry).map(e => (e === clash ? merged : e)),
            word: nextWord, merged: true, formChanged,
        };
    }
    return { wordbook: wordbook.map(e => (e === entry ? edited : e)), word: nextWord, merged: false, formChanged };
}
