// Exports the wordbook as an Anki package (.apkg), with sounds and images.
//
//   words ─▶ notes of one note type ("Polyglot"), one card each, all new
//         ─▶ collection.anki2 (SQLite, schema 11, sqlite-write.ts)
//         ─▶ zip: collection.anki2 · media (number → file name) · 0, 1, 2… (the files)
//
// Built from the package format's public description, with Polyglot's own
// code (no Anki code). Schema 11 is the "support older Anki versions" format,
// which every Anki (desktop, AnkiDroid, AnkiMobile) imports.
//
// Each note's guid comes from the word and its language, so exporting again
// updates the notes already imported instead of adding copies. The review
// schedule is not exported: the cards start as new in Anki.
import { buildSqlite } from './sqlite-write.js';
import { sha1Hex } from './sha1.js';
import { buildZip } from '../zip.js';
import { clozeOf } from '../card-kind.js';
import { isCard, isMissed, wordStatus } from '../srs.js';
import { mediaIn, inParallel } from '../media-files.js';
import { readUserBytes } from '../user-files.js';
import { storeMode } from '../data-store.js';
import { downloadBlob } from './download.js';
/** Fixed, so a later export finds the note type it imported before. */
const MODEL_ID = 1_747_000_000_123;
const MODEL_NAME = 'Polyglot';
const FIELDS = ['Word', 'Pronunciation', 'Meaning', 'Context', 'BaseForm', 'PartOfSpeech',
    'Example', 'ExampleTranslation', 'Notes', 'Audio', 'Image'];
const FRONT = `<div class="pg-word">{{Word}}</div>
{{#Pronunciation}}<div class="pg-pron">{{Pronunciation}}</div>{{/Pronunciation}}
{{Audio}}`;
const BACK = `{{FrontSide}}
<hr id="answer">
<div class="pg-meaning">{{Meaning}}</div>
{{#Context}}<div class="pg-sub">{{Context}}</div>{{/Context}}
{{#BaseForm}}<div class="pg-sub">{{BaseForm}}</div>{{/BaseForm}}
{{#PartOfSpeech}}<div class="pg-pos">{{PartOfSpeech}}</div>{{/PartOfSpeech}}
{{#Image}}<div class="pg-img">{{Image}}</div>{{/Image}}
{{#Example}}<div class="pg-example">{{Example}}</div>{{/Example}}
{{#ExampleTranslation}}<div class="pg-sub">{{ExampleTranslation}}</div>{{/ExampleTranslation}}
{{#Notes}}<div class="pg-notes">{{Notes}}</div>{{/Notes}}`;
const CSS = `.card { font-family: sans-serif; font-size: 20px; text-align: center; }
.pg-word { font-size: 1.8em; font-weight: 600; }
.pg-pron, .pg-sub, .pg-pos { opacity: 0.6; font-size: 0.85em; }
.pg-pos { font-style: italic; }
.pg-meaning { font-size: 1.2em; margin-bottom: 0.3em; }
.pg-example { margin-top: 0.8em; }
.pg-notes { margin-top: 0.8em; font-size: 0.85em; opacity: 0.8; }
.pg-img img { max-width: 100%; max-height: 260px; margin-top: 0.6em; }`;
const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n'
    + '\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';
const SCHEMA = {
    col: 'CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null)',
    notes: 'CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null)',
    cards: 'CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null)',
    revlog: 'CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null)',
    graves: 'CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)',
};
// ── Fields ────────────────────────────────────────────────────────────────────
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/**
 * Field text: Anki fields are HTML, so words and notes are escaped (a note's
 * line breaks kept). Control characters go: U+001F separates a note's fields.
 */
const esc = (s) => (s ?? '')
    .replace(/[&<>"']/g, c => ESC[c])
    .replace(/\r?\n/g, '<br>')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
/** The example with the word in bold. */
function example(e) {
    const cloze = clozeOf(e);
    if (!cloze)
        return esc(e.example);
    return cloze.parts.map(esc).join(`<b>${esc(cloze.answer)}</b>`);
}
/** A tag: Anki tags hold no spaces. */
const tag = (s) => s.trim().replace(/\s+/g, '_');
/** Tags for the word: Polyglot, its level, language, sets, status and "often missed". */
function tagsOf(e, sets) {
    const out = ['Polyglot', `Polyglot::Level::${tag(e.level || 'grammar')}`];
    for (const lang of e.langs ?? [])
        out.push(`Polyglot::Lang::${tag(lang)}`);
    for (const id of e.setIds ?? []) {
        const name = sets.get(id);
        if (name)
            out.push(`Polyglot::Set::${tag(name)}`);
    }
    if (isCard(e))
        out.push(`Polyglot::${{ new: 'New', learning: 'Learning', known: 'Known' }[wordStatus(e)]}`);
    if (isMissed(e))
        out.push('Polyglot::Missed');
    return [...new Set(out)];
}
/** The note's fields, in FIELDS order. Sounds and pictures only when their file is in the package. */
function fieldsOf(e, media) {
    return [
        esc(e.word),
        esc(e.reading || e.ipa),
        esc(e.meaning),
        e.context_meaning && e.context_meaning !== e.meaning ? esc(e.context_meaning) : '',
        e.base_form && e.base_form !== e.word ? esc(e.base_form) : '',
        esc(e.pos_info),
        example(e) + (e.example_audio && media.has(e.example_audio) ? ` [sound:${e.example_audio}]` : ''),
        esc(e.example_translation),
        esc(e.notes),
        e.audio && media.has(e.audio) ? `[sound:${e.audio}]` : '',
        e.image && media.has(e.image) ? `<img src="${esc(e.image)}">` : '',
    ];
}
/** Stable guid for a word in a language: the same note on every export. */
const guidOf = (e) => `pg${sha1Hex(`${(e.langs ?? []).join(',')}\u001f${e.word}`).slice(0, 14)}`;
/** Anki's duplicate checksum: the first field's SHA-1, first 8 hex digits. */
const checksum = (text) => parseInt(sha1Hex(text).slice(0, 8), 16);
/** A deck id from its name (a later export of the same deck lands in it). */
const deckIdOf = (name) => 1_747_100_000_000 + (parseInt(sha1Hex(name).slice(0, 7), 16) % 100_000_000);
/** The collection's tables: the note type, the deck, one note and one new card per word. */
export function collectionTables({ entries, sets, deckName, media, now = Date.now() }) {
    const sec = Math.floor(now / 1000);
    const deckId = deckIdOf(deckName);
    const setNames = new Map(sets.map(s => [s.id, s.name]));
    const mediaNames = new Set(media.keys());
    const model = {
        id: MODEL_ID, name: MODEL_NAME, type: 0, mod: sec, usn: -1, sortf: 0, did: deckId,
        tmpls: [{ name: 'Card 1', ord: 0, qfmt: FRONT, afmt: BACK, did: null, bqfmt: '', bafmt: '' }],
        flds: FIELDS.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
        css: CSS, latexPre: LATEX_PRE, latexPost: '\\end{document}', latexsvg: false,
        req: [[0, 'any', [0]]], tags: [], vers: [],
    };
    const deck = (id, name) => ({
        id, name, desc: '', mod: sec, usn: -1, collapsed: false, browserCollapsed: false, dyn: 0, conf: 1,
        extendNew: 0, extendRev: 50, newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0],
    });
    const dconf = {
        id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
        new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
        rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
        lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
    };
    const conf = {
        activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true,
        curModel: String(MODEL_ID), nextPos: entries.length + 1, sortType: 'noteFld', sortBackwards: false, addToCur: true,
    };
    // Ids: milliseconds, unique, in wordbook order
    const notes = entries.map((e, i) => {
        const id = now - entries.length + i;
        const fields = fieldsOf(e, mediaNames);
        const tags = tagsOf(e, setNames);
        return {
            rowid: id,
            values: [null, guidOf(e), MODEL_ID, sec, -1, ` ${tags.join(' ')} `, fields.join('\u001f'),
                e.word, checksum(e.word), 0, ''],
        };
    });
    const cards = notes.map((n, i) => ({
        rowid: n.rowid,
        values: [null, n.rowid, deckId, 0, sec, -1, 0, 0, i + 1, 0, 0, 0, 0, 0, 0, 0, 0, ''],
    }));
    return [
        { name: 'col', sql: SCHEMA.col, rows: [{ rowid: 1, values: [
                        null, Math.floor(sec / 86400) * 86400, now, now, 11, 0, 0, 0,
                        JSON.stringify(conf), JSON.stringify({ [MODEL_ID]: model }),
                        JSON.stringify({ 1: deck(1, 'Default'), [deckId]: deck(deckId, deckName) }),
                        JSON.stringify({ 1: dconf }), '{}',
                    ] }] },
        { name: 'notes', sql: SCHEMA.notes, rows: notes, indexes: [
                { name: 'ix_notes_usn', sql: 'CREATE INDEX ix_notes_usn on notes (usn)', columns: [4] },
                { name: 'ix_notes_csum', sql: 'CREATE INDEX ix_notes_csum on notes (csum)', columns: [8] },
            ] },
        { name: 'cards', sql: SCHEMA.cards, rows: cards, indexes: [
                { name: 'ix_cards_usn', sql: 'CREATE INDEX ix_cards_usn on cards (usn)', columns: [5] },
                { name: 'ix_cards_nid', sql: 'CREATE INDEX ix_cards_nid on cards (nid)', columns: [1] },
                { name: 'ix_cards_sched', sql: 'CREATE INDEX ix_cards_sched on cards (did, queue, due)', columns: [2, 7, 8] },
            ] },
        { name: 'revlog', sql: SCHEMA.revlog, rows: [], indexes: [
                { name: 'ix_revlog_usn', sql: 'CREATE INDEX ix_revlog_usn on revlog (usn)', columns: [2] },
                { name: 'ix_revlog_cid', sql: 'CREATE INDEX ix_revlog_cid on revlog (cid)', columns: [1] },
            ] },
        { name: 'graves', sql: SCHEMA.graves, rows: [] },
    ];
}
/** The package: the collection, the media list and the media files (named 0, 1, 2…). */
export function buildApkg(input) {
    const names = [...input.media.keys()];
    const files = [
        { name: 'collection.anki2', data: buildSqlite(collectionTables(input)) },
        { name: 'media', data: new TextEncoder().encode(JSON.stringify(Object.fromEntries(names.map((n, i) => [String(i), n])))) },
        ...names.map((n, i) => ({ name: String(i), data: input.media.get(n) })),
    ];
    return buildZip(files);
}
/** Files read at once while gathering sounds and pictures. */
const READ_PARALLEL = 4;
/**
 * Downloads `entries` as an Anki package for study language `lang`, with the
 * sounds and pictures that can be read. Returns how many words and files it
 * holds, and how many files could not be read (left out of their notes).
 * `onMedia` hears how many files have been read.
 */
export async function exportToApkg(entries, sets, lang, onMedia) {
    const names = storeMode() === 'file' ? [...mediaIn(entries)] : [];
    const media = new Map();
    let done = 0;
    onMedia?.(0, names.length);
    await inParallel(names, READ_PARALLEL, async (name) => {
        const data = await readUserBytes(name);
        if (data)
            media.set(name, data);
        onMedia?.(++done, names.length);
    });
    const deck = lang.trim() || 'Words';
    downloadBlob(buildApkg({ entries, sets, deckName: `Polyglot::${deck}`, media }), `Polyglot_${deck.replace(/[^\p{L}\p{N}_-]+/gu, '_')}_${new Date().toISOString().slice(0, 10)}.apkg`);
    return { words: entries.length, media: media.size, missing: names.length - media.size };
}
