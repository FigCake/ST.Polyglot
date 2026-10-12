// A small SQLite file writer: enough to build an Anki collection for export
// without shipping a SQLite engine (deck-import/sqlite.ts is its reader).
//
//   tables + rows + indexes ─▶ b-trees, bottom-up ─▶ pages ─▶ one file
//
// Written from SQLite's published file format (sqlite.org/fileformat.html):
// 4096-byte pages, UTF-8, schema format 4, rowid tables whose INTEGER PRIMARY
// KEY is the rowid, plain indexes over their rows, overflow pages for long
// values. No free pages, no WAL: a freshly built file, read-only from here.
//
// Pure — no DOM, no I/O.
const PAGE = 4096;
const USABLE = PAGE; // no reserved bytes
const MAX_LOCAL_TABLE = USABLE - 35;
const MAX_LOCAL_INDEX = Math.floor((USABLE - 12) * 64 / 255) - 23;
const MIN_LOCAL = Math.floor((USABLE - 12) * 32 / 255) - 23;
const LEAF_TABLE = 0x0d, INTERIOR_TABLE = 0x05, LEAF_INDEX = 0x0a, INTERIOR_INDEX = 0x02;
// ── Encoding ──────────────────────────────────────────────────────────────────
const encoder = new TextEncoder();
/** SQLite's big-endian varint, for non-negative integers below 2^56. */
export function varint(v) {
    if (!Number.isSafeInteger(v) || v < 0)
        throw new RangeError(`varint: ${v}`);
    const out = [v % 128];
    for (let n = Math.floor(v / 128); n > 0; n = Math.floor(n / 128))
        out.unshift((n % 128) | 0x80);
    if (out.length > 8)
        throw new RangeError(`varint: ${v}`);
    return out;
}
/** Serial type and body bytes of one value (integers in the fewest bytes, as SQLite writes them). */
function encodeValue(v) {
    if (v === null)
        return [0, new Uint8Array(0)];
    if (typeof v === 'string') {
        const b = encoder.encode(v);
        return [b.length * 2 + 13, b];
    }
    if (!Number.isInteger(v)) {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, v);
        return [7, b];
    }
    if (v === 0)
        return [8, new Uint8Array(0)];
    if (v === 1)
        return [9, new Uint8Array(0)];
    const sizes = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 6], [6, 8]];
    for (const [type, bytes] of sizes) {
        const bits = BigInt(bytes * 8);
        const big = BigInt(v);
        if (big >= -(1n << (bits - 1n)) && big < (1n << (bits - 1n))) {
            let u = BigInt.asUintN(bytes * 8, big);
            const b = new Uint8Array(bytes);
            for (let i = bytes - 1; i >= 0; i--) {
                b[i] = Number(u & 0xffn);
                u >>= 8n;
            }
            return [type, b];
        }
    }
    throw new RangeError(`integer out of range: ${v}`);
}
/** A record: header (its own size, then one serial type per value) and the values' bytes. */
export function record(values) {
    const encoded = values.map(encodeValue);
    const types = encoded.flatMap(([t]) => varint(t));
    let headerSize = types.length + 1;
    while (varint(headerSize).length + types.length !== headerSize)
        headerSize = varint(headerSize).length + types.length;
    const parts = [Uint8Array.from([...varint(headerSize), ...types]), ...encoded.map(([, b]) => b)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}
/** Index order: NULL < numbers < text, numbers by value, text by bytes (BINARY collation). */
function compareValues(a, b) {
    const rank = (v) => (v === null ? 0 : typeof v === 'number' ? 1 : 2);
    if (rank(a) !== rank(b))
        return rank(a) - rank(b);
    if (typeof a === 'number' && typeof b === 'number')
        return a - b;
    if (typeof a === 'string' && typeof b === 'string') {
        const x = encoder.encode(a), y = encoder.encode(b);
        for (let i = 0; i < Math.min(x.length, y.length); i++)
            if (x[i] !== y[i])
                return x[i] - y[i];
        return x.length - y.length;
    }
    return 0;
}
// ── Pages ─────────────────────────────────────────────────────────────────────
class Pages {
    pages = [];
    /** Page 1 is reserved for the schema's root. */
    next = 2;
    alloc() { return this.next++; }
    set(no, page) { this.pages[no - 1] = page; }
    get count() { return this.next - 1; }
    file() {
        const out = new Uint8Array(this.count * PAGE);
        this.pages.forEach((p, i) => { if (p)
            out.set(p, i * PAGE); });
        return out;
    }
}
/**
 * The cell's payload as stored: the part kept on the page, and the rest in a
 * chain of overflow pages whose first page number ends the cell.
 */
function spill(payload, maxLocal, pages) {
    const p = payload.length;
    if (p <= maxLocal)
        return payload;
    const k = MIN_LOCAL + ((p - MIN_LOCAL) % (USABLE - 4));
    const local = k <= maxLocal ? k : MIN_LOCAL;
    const chunk = USABLE - 4;
    const numbers = [];
    for (let at = local; at < p; at += chunk)
        numbers.push(pages.alloc());
    numbers.forEach((no, i) => {
        const page = new Uint8Array(PAGE);
        new DataView(page.buffer).setUint32(0, numbers[i + 1] ?? 0);
        page.set(payload.subarray(local + i * chunk, local + (i + 1) * chunk), 4);
        pages.set(no, page);
    });
    const out = new Uint8Array(local + 4);
    out.set(payload.subarray(0, local));
    new DataView(out.buffer).setUint32(local, numbers[0]);
    return out;
}
const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
};
/** One b-tree page: header, cell pointers, cells packed at the end. Page 1 starts after the file header. */
function writePage(kind, cells, rightmost, first) {
    const page = new Uint8Array(PAGE);
    const view = new DataView(page.buffer);
    const start = first ? 100 : 0;
    const headerSize = rightmost === null ? 8 : 12;
    let content = PAGE;
    cells.forEach((cell, i) => {
        content -= cell.length;
        page.set(cell, content);
        view.setUint16(start + headerSize + i * 2, content);
    });
    page[start] = kind;
    view.setUint16(start + 3, cells.length);
    view.setUint16(start + 5, content); // an empty page: its end (0 would mean 65536)
    if (rightmost !== null)
        view.setUint32(start + 8, rightmost);
    return page;
}
/** Room for cells on a page (header and pointers aside). */
const room = (interior, first) => PAGE - (first ? 100 : 0) - (interior ? 12 : 8);
/** Whether cells fit one page. */
const fits = (cells, interior, first) => cells.reduce((n, c) => n + c.length + 2, 0) <= room(interior, first);
// ── Table b-tree ──────────────────────────────────────────────────────────────
/**
 * Splits items into page-sized groups, in order: `fit` tells whether a group
 * fits a page. A last group left with one item takes one more from the group
 * before it, so no interior page is left with only its right-most child.
 */
function groups(items, fit) {
    const out = [];
    let g = [];
    for (const item of items) {
        if (g.length && !fit([...g, item])) {
            out.push(g);
            g = [];
        }
        g.push(item);
    }
    out.push(g);
    if (out.length > 1 && out[out.length - 1].length === 1 && out[out.length - 2].length > 2) {
        out[out.length - 1].unshift(out[out.length - 2].pop());
    }
    // Fits one normal page but not the root's (page 1 is 100 bytes short): two pages, so a level is added
    if (out.length === 1 && g.length > 1)
        return [g.slice(0, g.length >> 1), g.slice(g.length >> 1)];
    return out;
}
/** Builds a rowid table's b-tree; returns its root page (`root` when given). */
function tableTree(rows, pages, root) {
    const sorted = [...rows].sort((a, b) => a.rowid - b.rowid);
    const onPage1 = root === 1;
    const leafCells = sorted.map(r => ({
        cell: concat(varint(r.payload.length), varint(r.rowid), spill(r.payload, MAX_LOCAL_TABLE, pages)),
        key: r.rowid,
    }));
    // The whole table on its root page
    if (fits(leafCells.map(c => c.cell), false, onPage1)) {
        const no = root ?? pages.alloc();
        pages.set(no, writePage(LEAF_TABLE, leafCells.map(c => c.cell), null, onPage1));
        return no;
    }
    // Leaves, then interior levels until one page holds them all
    let level = groups(leafCells, g => fits(g.map(c => c.cell), false, false)).map(g => {
        const no = pages.alloc();
        pages.set(no, writePage(LEAF_TABLE, g.map(c => c.cell), null, false));
        return { no, maxKey: g[g.length - 1].key };
    });
    for (;;) {
        // A child's cell: its page and its largest key; a page's last child is its right-most pointer
        const cellOf = (c) => {
            const cell = concat([0, 0, 0, 0], varint(c.maxKey));
            new DataView(cell.buffer).setUint32(0, c.no);
            return cell;
        };
        const cellsOf = (g) => g.slice(0, -1).map(cellOf);
        if (fits(cellsOf(level), true, onPage1) && (level.length > 1)) {
            const no = root ?? pages.alloc();
            pages.set(no, writePage(INTERIOR_TABLE, cellsOf(level), level[level.length - 1].no, onPage1));
            return no;
        }
        level = groups(level, g => fits(cellsOf(g), true, false)).map(g => {
            const no = pages.alloc();
            pages.set(no, writePage(INTERIOR_TABLE, cellsOf(g), g[g.length - 1].no, false));
            return { no, maxKey: g[g.length - 1].maxKey };
        });
    }
}
// ── Index b-tree ──────────────────────────────────────────────────────────────
/**
 * Builds an index b-tree over `keys` (each the indexed values then the rowid);
 * returns its root page. In an index b-tree the entries on interior pages are
 * entries themselves, so each split moves one entry up.
 */
function indexTree(keys, pages) {
    const sorted = [...keys].sort((a, b) => {
        for (let i = 0; i < a.length; i++) {
            const c = compareValues(a[i], b[i]);
            if (c)
                return c;
        }
        return 0;
    });
    let entries = sorted.map(k => { const p = record(k); return concat(varint(p.length), spill(p, MAX_LOCAL_INDEX, pages)); });
    // children[i] holds the pages below; null on the leaf level
    let children = null;
    for (;;) {
        const interior = children !== null;
        const withChild = (cell, child) => {
            const out = concat([0, 0, 0, 0], cell);
            new DataView(out.buffer).setUint32(0, child);
            return out;
        };
        // Pages: runs of entries; one entry between two runs goes up
        const runs = [];
        const ups = [];
        let cells = [];
        let first = 0;
        for (let i = 0; i < entries.length; i++) {
            const cell = interior ? withChild(entries[i], children[i]) : entries[i];
            if (cells.length && !fits([...cells, cell], interior, false)) {
                // This entry goes up; the next run starts after it (keep at least one entry for it)
                if (i === entries.length - 1) {
                    ups.push(entries[i - 1]);
                    cells.pop();
                    runs.push({ cells, first });
                    cells = [];
                    first = i;
                }
                else {
                    runs.push({ cells, first });
                    ups.push(entries[i]);
                    cells = [];
                    first = i + 1;
                    continue;
                }
            }
            cells.push(cell);
        }
        runs.push({ cells, first });
        const kind = interior ? INTERIOR_INDEX : LEAF_INDEX;
        // The right-most child of a run: the child just after its last entry
        const rightmost = (run) => interior ? children[run.first + run.cells.length] : null;
        if (runs.length === 1) {
            const no = pages.alloc();
            pages.set(no, writePage(kind, runs[0].cells, rightmost(runs[0]), false));
            return no;
        }
        const numbers = runs.map(run => {
            const no = pages.alloc();
            pages.set(no, writePage(kind, run.cells, rightmost(run), false));
            return no;
        });
        entries = ups;
        children = numbers;
    }
}
// ── File ──────────────────────────────────────────────────────────────────────
/** A SQLite database file holding `tables` (with their indexes). */
export function buildSqlite(tables) {
    const pages = new Pages();
    const schema = [];
    for (const t of tables) {
        const root = tableTree(t.rows.map(r => ({ rowid: r.rowid, payload: record(r.values) })), pages);
        schema.push({ rowid: schema.length + 1, payload: record(['table', t.name, t.name, root, t.sql]) });
        for (const ix of t.indexes ?? []) {
            const ixRoot = indexTree(t.rows.map(r => [...ix.columns.map(c => r.values[c]), r.rowid]), pages);
            schema.push({ rowid: schema.length + 1, payload: record(['index', ix.name, t.name, ixRoot, ix.sql]) });
        }
    }
    tableTree(schema, pages, 1);
    const file = pages.file();
    const view = new DataView(file.buffer);
    file.set(encoder.encode('SQLite format 3\u0000'), 0);
    view.setUint16(16, PAGE);
    file[18] = 1;
    file[19] = 1; // legacy (rollback journal) file format
    file[20] = 0; // reserved bytes per page
    file[21] = 64;
    file[22] = 32;
    file[23] = 32; // payload fractions (fixed values)
    view.setUint32(24, 1); // file change counter
    view.setUint32(28, pages.count); // database size in pages
    view.setUint32(40, 1); // schema cookie
    view.setUint32(44, 4); // schema format
    view.setUint32(56, 1); // UTF-8
    view.setUint32(92, 1); // version-valid-for = change counter
    view.setUint32(96, 3045001); // SQLite version that "wrote" it
    return file;
}
