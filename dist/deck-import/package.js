// Opens an Anki package (.apkg, or a whole-profile .colpkg) and lists its
// note types, notes and media.
//
//   zip ─┬─ collection.anki21b   zstd(SQLite, schema 18)   Anki 2.1.50+
//        ├─ collection.anki21    SQLite (schema 11)         "support older versions"
//        ├─ collection.anki2     SQLite (schema 11)         Anki 2.0 — or a stub
//        │                                                  "please update" note
//        ├─ media                JSON {"0": "cat.png"}  or  zstd(protobuf list)
//        └─ 0, 1, 2 …            media files (zstd-compressed in the new format)
//
// Compression is told by the bytes themselves (zstd magic), not by the version.
//
// Media bytes are read only when asked for, one file at a time.
import { readZip, readEntry } from '../zip.js';
import { zstdDecompress, isZstd } from './zstd.js';
import { SqliteFile } from './sqlite.js';
export class AnkiFormatError extends Error {
}
const SEP = '\u001f';
/** Note types and decks of a schema 11 collection (JSON in the col table). */
function legacyCollection(db) {
    const [col] = [...db.rows('col')];
    const models = JSON.parse(String(col?.values[9] ?? '{}'));
    const decks = JSON.parse(String(col?.values[10] ?? '{}'));
    return {
        noteTypes: Object.entries(models).map(([id, m]) => ({
            id: Number(m.id ?? id),
            name: String(m.name ?? id),
            fields: [...(m.flds ?? [])].sort((a, b) => a.ord - b.ord).map(f => f.name),
        })),
        decks: new Map(Object.entries(decks).map(([id, d]) => [Number(id), String(d.name ?? '')])),
    };
}
/** Note types and decks of a schema 18 collection (their own tables). */
function modernCollection(db) {
    const fields = new Map();
    for (const { values: [ntid, ord, name] } of db.rows('fields')) {
        const list = fields.get(Number(ntid)) ?? [];
        list.push({ ord: Number(ord), name: String(name) });
        fields.set(Number(ntid), list);
    }
    return {
        noteTypes: [...db.rows('notetypes')].map(({ rowid, values }) => ({
            id: Number(rowid),
            name: String(values[1]),
            fields: (fields.get(Number(rowid)) ?? []).sort((a, b) => a.ord - b.ord).map(f => f.name),
        })),
        decks: new Map([...db.rows('decks')].map(({ rowid, values }) => [Number(rowid), String(values[1]).split(SEP).join('::')])),
    };
}
function readCollection(db) {
    const { noteTypes, decks } = db.hasTable('notetypes') ? modernCollection(db) : legacyCollection(db);
    // A note's deck is its first card's deck — its home deck (odid) while the card sits in a filtered deck
    const deckOf = new Map();
    for (const { values } of db.rows('cards')) {
        const [, nid, did, ord] = values;
        const home = Number(values[15]) || Number(did); // cards.odid: 0 unless in a filtered deck
        const prev = deckOf.get(Number(nid));
        if (!prev || Number(ord) < prev.ord)
            deckOf.set(Number(nid), { ord: Number(ord), did: home });
    }
    const notes = [];
    for (const { rowid, values } of db.rows('notes')) {
        notes.push({
            typeId: Number(values[2]),
            fields: String(values[6] ?? '').split(SEP),
            tags: String(values[5] ?? '').trim().split(/\s+/).filter(Boolean),
            deck: decks.get(deckOf.get(Number(rowid))?.did ?? -1) ?? '',
        });
    }
    return { noteTypes, notes };
}
// ── Media list ────────────────────────────────────────────────────────────────
/** Minimal protobuf reading for MediaEntries { repeated MediaEntry { string name = 1; … } = 1 }. */
function mediaNamesFromProtobuf(bytes) {
    const names = [];
    const text = new TextDecoder();
    const bad = () => { throw new AnkiFormatError('bad media list'); };
    const varint = (p) => {
        let v = 0, mul = 1, i = p;
        for (; bytes[i] & 0x80; i++, mul *= 128)
            v += (bytes[i] & 0x7f) * mul;
        if (i >= bytes.length)
            bad();
        return [v + bytes[i] * mul, i + 1];
    };
    /** Calls `fn` with each field of the message in bytes[start, end); a length past the data is an error. */
    const fields = (start, end, fn) => {
        if (end > bytes.length)
            bad();
        for (let p = start; p < end;) {
            const [key, a] = varint(p);
            const no = Math.floor(key / 8), wire = key & 7;
            if (wire === 0) {
                p = varint(a)[1];
            }
            else if (wire === 2) {
                const [len, b] = varint(a);
                if (b + len > end)
                    bad();
                fn(no, b, b + len);
                p = b + len;
            }
            else if (wire === 5)
                p = a + 4;
            else if (wire === 1)
                p = a + 8;
            else
                bad();
        }
    };
    fields(0, bytes.length, (no, from, to) => {
        if (no !== 1)
            return;
        let name = '';
        fields(from, to, (n, a, b) => { if (n === 1)
            name = text.decode(bytes.subarray(a, b)); });
        names.push(name);
    });
    return names;
}
// ── Opening a package ─────────────────────────────────────────────────────────
const STUB_NOTE = /please update to the latest anki version/i;
export async function readAnkiPackage(file) {
    const entries = await readZip(file);
    const entry = (name) => entries.get(name);
    const read = (e) => readEntry(file, e);
    const modern = entry('collection.anki21b');
    const legacy = entry('collection.anki21') ?? entry('collection.anki2');
    if (!modern && !legacy)
        throw new AnkiFormatError('no collection in package');
    const dbBytes = modern ? zstdDecompress(await read(modern)) : await read(legacy);
    const { noteTypes, notes } = readCollection(new SqliteFile(dbBytes));
    if (!modern && notes.length === 1 && STUB_NOTE.test(notes[0].fields[0] ?? '')) {
        throw new AnkiFormatError('stub collection');
    }
    // Media: name → zip entry
    const mediaEntry = entry('media');
    let names = {};
    if (mediaEntry) {
        const raw = await read(mediaEntry);
        names = isZstd(raw)
            ? Object.fromEntries(mediaNamesFromProtobuf(zstdDecompress(raw)).map((n, i) => [String(i), n]))
            : JSON.parse(new TextDecoder().decode(raw) || '{}');
    }
    const byName = new Map(Object.entries(names).map(([zipName, name]) => [name, zipName]));
    return {
        noteTypes: noteTypes.filter(nt => notes.some(n => n.typeId === nt.id)),
        notes,
        media: new Set(byName.keys()),
        readMedia: async (name) => {
            const zipName = byName.get(name);
            const e = zipName === undefined ? undefined : entry(zipName);
            if (!e)
                return null;
            const bytes = await read(e);
            return isZstd(bytes) ? zstdDecompress(bytes) : bytes;
        },
    };
}
