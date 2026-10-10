// ════════════════════════════
// Polyglot  anki/sqlite.ts
// ════════════════════════════
// A read-only SQLite file reader: enough to scan the tables of an Anki
// collection without shipping a SQLite engine (sql.js is ~1 MB of wasm).
//
//   file ─▶ page 1: sqlite_schema ─▶ a table's root page
//        ─▶ walk its b-tree in key order ─▶ records ─▶ values
//
// Handles rowid tables and WITHOUT ROWID tables (index b-trees), overflow
// pages and UTF-8 / UTF-16 text. No SQL: rows come back as value arrays in
// column order. In a rowid table an INTEGER PRIMARY KEY column is stored as
// NULL; its value is the row's `rowid`.
//
// Pure — no DOM, no I/O.
export class SqliteError extends Error {
}
const fail = (why) => { throw new SqliteError(`sqlite: ${why}`); };
const HEADER = 'SQLite format 3\u0000';
export class SqliteFile {
    data;
    view;
    pageSize;
    usable;
    decoder;
    schema;
    constructor(data) {
        this.data = data;
        if (data.length < 100 || new TextDecoder().decode(data.subarray(0, 16)) !== HEADER)
            fail('not a SQLite file');
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const size = this.view.getUint16(16);
        this.pageSize = size === 1 ? 65536 : size;
        this.usable = this.pageSize - data[20];
        const encoding = this.view.getUint32(56);
        this.decoder = new TextDecoder(encoding === 2 ? 'utf-16le' : encoding === 3 ? 'utf-16be' : 'utf-8');
    }
    /** Names of the tables in the file. */
    tables() {
        return this.schemaRows().filter(r => r.type === 'table').map(r => r.name);
    }
    hasTable(name) {
        return this.schemaRows().some(r => r.type === 'table' && r.name === name);
    }
    /** Every row of a table, in key order. */
    *rows(table) {
        const entry = this.schemaRows().find(r => r.type === 'table' && r.name === table) ?? fail(`no table ${table}`);
        yield* this.walk(entry.root, new Set());
    }
    schemaRows() {
        this.schema ??= [...this.walk(1, new Set())].map(({ values: [type, name, , root, sql] }) => ({
            type: String(type), name: String(name), root: Number(root), sql: String(sql ?? ''),
        }));
        return this.schema;
    }
    // ── B-trees ───────────────────────────────────────────────────────────────
    *walk(page, seen) {
        if (seen.has(page) || page < 1 || page * this.pageSize > this.data.length)
            fail('bad page reference');
        seen.add(page);
        const base = (page - 1) * this.pageSize;
        const header = page === 1 ? 100 : 0;
        const at = base + header;
        const type = this.data[at];
        const count = this.view.getUint16(at + 3);
        const leaf = type === 10 || type === 13;
        const cells = at + (leaf ? 8 : 12);
        if (![2, 5, 10, 13].includes(type))
            fail(`unknown page type ${type}`);
        for (let i = 0; i < count; i++) {
            let p = base + this.view.getUint16(cells + i * 2);
            if (type === 13) {
                const [size, n1] = this.varint(p);
                p += n1;
                const [rowid, n2] = this.varint(p);
                p += n2;
                yield { rowid, values: this.record(this.payload(p, size, true)) };
            }
            else if (type === 10) {
                const [size, n] = this.varint(p);
                yield { values: this.record(this.payload(p + n, size, false)) };
            }
            else if (type === 5) {
                yield* this.walk(this.view.getUint32(p), seen);
            }
            else {
                // Interior index cell: the left subtree, then the cell's own key
                yield* this.walk(this.view.getUint32(p), seen);
                const [size, n] = this.varint(p + 4);
                yield { values: this.record(this.payload(p + 4 + n, size, false)) };
            }
        }
        if (!leaf)
            yield* this.walk(this.view.getUint32(at + 8), seen);
    }
    /** A cell's payload, following overflow pages when it does not fit. */
    payload(p, size, table) {
        const u = this.usable;
        const max = table ? u - 35 : Math.floor((u - 12) * 64 / 255) - 23;
        if (size <= max)
            return this.data.subarray(p, p + size);
        const min = Math.floor((u - 12) * 32 / 255) - 23;
        const k = min + ((size - min) % (u - 4));
        const local = k <= max ? k : min;
        const out = new Uint8Array(size);
        out.set(this.data.subarray(p, p + local));
        let filled = local;
        let next = this.view.getUint32(p + local);
        const seen = new Set();
        while (filled < size) {
            if (!next || seen.has(next))
                fail('broken overflow chain');
            seen.add(next);
            const base = (next - 1) * this.pageSize;
            const n = Math.min(u - 4, size - filled);
            out.set(this.data.subarray(base + 4, base + 4 + n), filled);
            filled += n;
            next = this.view.getUint32(base);
        }
        return out;
    }
    // ── Records ───────────────────────────────────────────────────────────────
    varint(p, data = this.data) {
        let v = 0;
        for (let i = 0; i < 8; i++) {
            const b = data[p + i];
            v = v * 128 + (b & 0x7f);
            if (b < 0x80)
                return [v, i + 1];
        }
        return [v * 256 + data[p + 8], 9];
    }
    record(rec) {
        const [headerSize, n] = this.varint(0, rec);
        const types = [];
        for (let p = n; p < headerSize;) {
            const [t, len] = this.varint(p, rec);
            types.push(t);
            p += len;
        }
        const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        const values = [];
        let p = headerSize;
        for (const t of types) {
            if (t === 0)
                values.push(null);
            else if (t <= 6) {
                const size = [0, 1, 2, 3, 4, 6, 8][t];
                values.push(signed(rec, p, size));
                p += size;
            }
            else if (t === 7) {
                values.push(view.getFloat64(p));
                p += 8;
            }
            else if (t === 8)
                values.push(0);
            else if (t === 9)
                values.push(1);
            else if (t >= 12) {
                const size = (t - (t & 1 ? 13 : 12)) / 2;
                const bytes = rec.subarray(p, p + size);
                values.push(t & 1 ? this.decoder.decode(bytes) : bytes);
                p += size;
            }
            else
                fail(`reserved serial type ${t}`);
        }
        return values;
    }
}
/** A big-endian two's-complement integer of 1–8 bytes (exact up to 2^53). */
function signed(b, p, size) {
    let v = 0;
    for (let i = 0; i < size; i++)
        v = v * 256 + b[p + i];
    return b[p] & 0x80 ? v - 2 ** (size * 8) : v;
}
