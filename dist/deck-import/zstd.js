// Zstandard decompression (RFC 8878), for Anki packages: Anki 2.1.50+ stores
// the collection and every media file zstd-compressed, and browsers'
// DecompressionStream has no zstd.
//
//   frame ─▶ blocks: raw · RLE · compressed
//                         └─ literals (raw / RLE / Huffman, 1 or 4 streams)
//                          + sequences (FSE-coded literal length, offset, match length)
//
// Decoding only, no dictionaries; the content checksum is not verified (the
// zip's CRC, which readEntry checks, already covers the bytes). Skippable
// frames are skipped. Output is capped (a tiny frame can describe gigabytes)
// and must match the size a frame header states.
//
// Pure — no DOM, no I/O.
export class ZstdError extends Error {
}
const fail = (why) => { throw new ZstdError(`zstd: ${why}`); };
const highBit = (n) => 31 - Math.clz32(n);
// ── Output ────────────────────────────────────────────────────────────────────
/** Largest output zstdDecompress produces by default. */
export const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
/** A growing byte buffer, up to `max` bytes; matches copy from what was written before. */
class Output {
    max;
    buf;
    len = 0;
    constructor(size, max) {
        this.max = max;
        this.buf = new Uint8Array(Math.min(Math.max(size, 1024), max));
    }
    reserve(n) {
        if (!(n >= 0))
            fail('bad length');
        if (this.len + n > this.max)
            fail(`output larger than ${this.max} bytes`);
        if (this.len + n <= this.buf.length)
            return;
        let size = this.buf.length * 2;
        while (size < this.len + n)
            size *= 2;
        size = Math.min(size, this.max);
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }
    bytes(src, from, n) {
        this.reserve(n);
        this.buf.set(src.subarray(from, from + n), this.len);
        this.len += n;
    }
    fill(byte, n) {
        this.reserve(n);
        this.buf.fill(byte, this.len, this.len + n);
        this.len += n;
    }
    match(offset, n) {
        if (!(offset > 0 && offset <= this.len))
            fail('match offset out of range');
        this.reserve(n);
        const b = this.buf;
        let from = this.len - offset;
        if (offset >= n)
            b.copyWithin(this.len, from, from + n);
        else
            for (let i = 0; i < n; i++)
                b[this.len + i] = b[from++]; // overlapping: byte by byte
        this.len += n;
    }
}
// ── Bit readers ───────────────────────────────────────────────────────────────
/** Forward, little-endian bits (FSE table descriptions). */
class ForwardBits {
    data;
    end;
    pos; // bit position
    constructor(data, start, end) {
        this.data = data;
        this.end = end;
        this.pos = start * 8;
    }
    peek(n) {
        let v = 0;
        for (let i = 0; i < n; i++) {
            const p = this.pos + i, byte = p >> 3;
            if (byte < this.end && (this.data[byte] >> (p & 7)) & 1)
                v += 2 ** i;
        }
        return v;
    }
    skip(n) { this.pos += n; }
    /** Index of the first byte after the bits read. */
    get byteEnd() { return Math.ceil(this.pos / 8); }
}
/**
 * Backward bits (Huffman and FSE streams): the stream is read from its last
 * byte, starting below the highest set bit (the end marker). Reading past the
 * start yields zeros, which the format allows for the final symbols.
 */
class BackwardBits {
    data;
    start;
    /** Bits left before the start of the stream (negative once over-read). */
    left;
    length;
    constructor(data, start, end) {
        this.data = data;
        this.start = start;
        if (end <= start)
            fail('empty bitstream');
        const last = data[end - 1];
        if (!last)
            fail('bitstream without end marker');
        this.length = end - start;
        this.left = (this.length - 1) * 8 + highBit(last);
    }
    byte(i) {
        return i >= 0 && i < this.length ? this.data[this.start + i] : 0;
    }
    /** The next n (≤ 32) bits without consuming them. */
    peek(n) {
        if (!n)
            return 0;
        const lo = this.left - n; // lowest bit position wanted
        const first = Math.floor(lo / 8);
        const shift = lo - first * 8;
        if (n + shift <= 24 && first >= 0) {
            // Fast path: three bytes cover it
            const v = this.data[this.start + first] | (this.byte(first + 1) << 8) | (this.byte(first + 2) << 16);
            return (v >>> shift) & ((1 << n) - 1);
        }
        let v = 0;
        for (let k = 4; k >= 0; k--)
            v = v * 256 + this.byte(first + k);
        return Math.floor(v / 2 ** shift) % 2 ** n;
    }
    read(n) {
        const v = this.peek(n);
        this.left -= n;
        return v;
    }
}
/** Reads a normalised distribution (RFC 8878 §4.1.1); returns it and where it ended. */
function readDistribution(data, start, end, maxLog, maxSymbol) {
    const bits = new ForwardBits(data, start, end);
    const log = bits.peek(4) + 5;
    bits.skip(4);
    if (log > maxLog)
        fail('FSE accuracy too large');
    const norm = [];
    let remaining = (1 << log) + 1;
    let threshold = 1 << log;
    let nbBits = log + 1;
    let previous0 = false;
    while (remaining > 1 && norm.length <= maxSymbol) {
        if (previous0) {
            let repeat = bits.peek(2);
            bits.skip(2);
            let zeros = repeat;
            while (repeat === 3) {
                repeat = bits.peek(2);
                bits.skip(2);
                zeros += repeat;
            }
            for (let i = 0; i < zeros; i++)
                norm.push(0);
            if (norm.length > maxSymbol)
                break;
        }
        const max = 2 * threshold - 1 - remaining;
        let count;
        const low = bits.peek(nbBits - 1);
        if (low < max) {
            count = low;
            bits.skip(nbBits - 1);
        }
        else {
            count = bits.peek(nbBits);
            if (count >= threshold)
                count -= max;
            bits.skip(nbBits);
        }
        count--;
        remaining -= Math.abs(count);
        norm.push(count);
        previous0 = count === 0;
        while (remaining < threshold) {
            nbBits--;
            threshold >>= 1;
        }
    }
    if (remaining !== 1)
        fail('bad FSE distribution');
    return { norm, log, next: bits.byteEnd };
}
function buildFse(norm, log) {
    const size = 1 << log;
    const symbol = new Uint8Array(size), bits = new Uint8Array(size), baseline = new Uint16Array(size);
    const next = new Array(norm.length);
    let high = size - 1;
    norm.forEach((n, s) => {
        if (n === -1) {
            symbol[high--] = s;
            next[s] = 1;
        }
        else
            next[s] = n;
    });
    const step = (size >> 1) + (size >> 3) + 3;
    let pos = 0;
    norm.forEach((n, s) => {
        for (let i = 0; i < n; i++) {
            symbol[pos] = s;
            do
                pos = (pos + step) & (size - 1);
            while (pos > high);
        }
    });
    if (pos !== 0)
        fail('bad FSE table');
    for (let u = 0; u < size; u++) {
        const s = symbol[u];
        const n = next[s]++;
        bits[u] = log - highBit(n);
        baseline[u] = (n << bits[u]) - size;
    }
    return { log, symbol, bits, baseline };
}
const rleTable = (s) => ({ log: 0, symbol: Uint8Array.of(s), bits: Uint8Array.of(0), baseline: Uint16Array.of(0) });
// ── Sequence codes ────────────────────────────────────────────────────────────
const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const ML_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
    35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539,
];
const ML_BITS = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];
const LL_DEFAULT = buildFse([4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6);
const ML_DEFAULT = buildFse([
    1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
], 6);
const OF_DEFAULT = buildFse([1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5);
/** Reads a Huffman tree description; returns the table and where it ended. */
function readHuffman(data, start) {
    const header = data[start];
    let weights;
    let next;
    if (header < 128) {
        // FSE-compressed weights, two interleaved states
        const end = start + 1 + header;
        const { norm, log, next: streamStart } = readDistribution(data, start + 1, end, 6, 255);
        const fse = buildFse(norm, log);
        const bits = new BackwardBits(data, streamStart, end);
        let s1 = bits.read(log), s2 = bits.read(log);
        weights = [];
        for (;;) {
            weights.push(fse.symbol[s1]);
            s1 = fse.baseline[s1] + bits.read(fse.bits[s1]);
            if (bits.left < 0) {
                weights.push(fse.symbol[s2]);
                break;
            }
            weights.push(fse.symbol[s2]);
            s2 = fse.baseline[s2] + bits.read(fse.bits[s2]);
            if (bits.left < 0) {
                weights.push(fse.symbol[s1]);
                break;
            }
            if (weights.length > 255)
                fail('too many Huffman weights');
        }
        next = end;
    }
    else {
        // Direct: 4 bits per weight
        const count = header - 127;
        weights = [];
        for (let i = 0; i < count; i++) {
            const byte = data[start + 1 + (i >> 1)];
            weights.push(i & 1 ? byte & 15 : byte >> 4);
        }
        next = start + 1 + Math.ceil(count / 2);
    }
    // The last weight is implied: it completes the total to a power of two
    let total = 0;
    for (const w of weights)
        if (w)
            total += 1 << (w - 1);
    if (!total)
        fail('empty Huffman tree');
    const maxBits = highBit(total) + 1;
    const rest = (1 << maxBits) - total;
    if (rest & (rest - 1))
        fail('bad Huffman tree');
    weights.push(highBit(rest) + 1);
    if (maxBits > 11)
        fail('Huffman code too long');
    // Codes in order of weight, then symbol: weight w fills 2^(w-1) entries
    const size = 1 << maxBits;
    const symbol = new Uint8Array(size), bits = new Uint8Array(size);
    let pos = 0;
    for (let w = 1; w <= maxBits; w++) {
        weights.forEach((weight, s) => {
            if (weight !== w)
                return;
            const n = 1 << (w - 1);
            symbol.fill(s, pos, pos + n);
            bits.fill(maxBits + 1 - w, pos, pos + n);
            pos += n;
        });
    }
    return { table: { maxBits, symbol, bits }, next };
}
function decodeHuffmanStream(data, start, end, table, out, from, count) {
    const bits = new BackwardBits(data, start, end);
    for (let i = 0; i < count; i++) {
        const v = bits.peek(table.maxBits);
        out[from + i] = table.symbol[v];
        bits.left -= table.bits[v];
    }
    if (bits.left !== 0)
        fail('Huffman stream not fully consumed');
}
function readLiterals(data, p, state) {
    const b0 = data[p];
    const type = b0 & 3, format = (b0 >> 2) & 3;
    if (type === 0 || type === 1) {
        let size, header;
        if (format === 0 || format === 2) {
            size = b0 >> 3;
            header = 1;
        }
        else if (format === 1) {
            size = (b0 >> 4) + (data[p + 1] << 4);
            header = 2;
        }
        else {
            size = (b0 >> 4) + (data[p + 1] << 4) + (data[p + 2] << 12);
            header = 3;
        }
        const at = p + header;
        if (type === 0) {
            if (at + size > data.length)
                fail('literals past the end');
            return { literals: data.subarray(at, at + size), next: at + size };
        }
        return { literals: new Uint8Array(size).fill(data[at]), next: at + 1 };
    }
    // Huffman-coded (type 2 with a tree, 3 reusing the previous one)
    let regen, comp, header, streams = 4;
    if (format <= 1) {
        const v = b0 | (data[p + 1] << 8) | (data[p + 2] << 16);
        regen = (v >> 4) & 0x3ff;
        comp = (v >> 14) & 0x3ff;
        header = 3;
        if (format === 0)
            streams = 1;
    }
    else if (format === 2) {
        const v = (b0 | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;
        regen = (v >>> 4) & 0x3fff;
        comp = v >>> 18;
        header = 4;
    }
    else {
        const v = (b0 | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;
        regen = (v >>> 4) & 0x3ffff;
        comp = (v >>> 22) + data[p + 4] * 1024;
        header = 5;
    }
    let at = p + header;
    const end = at + comp;
    if (end > data.length)
        fail('literals past the end');
    if (type === 2) {
        const tree = readHuffman(data, at);
        state.huffman = tree.table;
        at = tree.next;
    }
    const table = state.huffman ?? fail('treeless literals without a previous tree');
    const literals = new Uint8Array(regen);
    if (streams === 1)
        decodeHuffmanStream(data, at, end, table, literals, 0, regen);
    else {
        const s1 = data[at] | (data[at + 1] << 8), s2 = data[at + 2] | (data[at + 3] << 8), s3 = data[at + 4] | (data[at + 5] << 8);
        const each = Math.ceil(regen / 4);
        let from = at + 6;
        const sizes = [s1, s2, s3, end - from - s1 - s2 - s3];
        sizes.forEach((size, i) => {
            const count = i < 3 ? each : regen - 3 * each;
            decodeHuffmanStream(data, from, from + size, table, literals, i * each, count);
            from += size;
        });
    }
    return { literals, next: end };
}
/** Reads one of the three sequence tables according to its mode. */
function readTable(data, p, mode, fallback, previous, maxLog, maxSymbol) {
    switch (mode) {
        case 0: return { table: fallback, next: p };
        case 1: return { table: rleTable(data[p]), next: p + 1 };
        case 2: {
            const { norm, log, next } = readDistribution(data, p, data.length, maxLog, maxSymbol);
            return { table: buildFse(norm, log), next };
        }
        default: return { table: previous ?? fail('repeated table without a previous one'), next: p };
    }
}
function decompressBlock(data, start, end, out, state) {
    const block = data.subarray(0, end);
    const { literals, next } = readLiterals(block, start, state);
    let p = next;
    // Number of sequences
    if (p >= end)
        fail('missing sequences section');
    const b0 = block[p];
    let count;
    if (b0 < 128) {
        count = b0;
        p += 1;
    }
    else if (b0 < 255) {
        count = ((b0 - 128) << 8) + block[p + 1];
        p += 2;
    }
    else {
        count = block[p + 1] + (block[p + 2] << 8) + 0x7f00;
        p += 3;
    }
    if (p > end)
        fail('truncated sequences header');
    if (!count) {
        if (p !== end)
            fail('bytes after an empty sequences section');
        out.bytes(literals, 0, literals.length);
        return;
    }
    const modes = block[p++];
    const ll = readTable(block, p, modes >> 6, LL_DEFAULT, state.ll, 9, 35);
    const of = readTable(block, ll.next, (modes >> 4) & 3, OF_DEFAULT, state.of, 8, 31);
    const ml = readTable(block, of.next, (modes >> 2) & 3, ML_DEFAULT, state.ml, 9, 52);
    state.ll = ll.table;
    state.of = of.table;
    state.ml = ml.table;
    const bits = new BackwardBits(block, ml.next, end);
    const LL = ll.table, OF = of.table, ML = ml.table;
    let sLL = bits.read(LL.log), sOF = bits.read(OF.log), sML = bits.read(ML.log);
    const reps = state.reps;
    let lit = 0;
    for (let i = 0; i < count; i++) {
        const ofCode = OF.symbol[sOF], mlCode = ML.symbol[sML], llCode = LL.symbol[sLL];
        if (ofCode === undefined || mlCode === undefined || llCode === undefined)
            fail('bad sequence state');
        if (ofCode > 31)
            fail('offset code too large');
        const ofValue = 2 ** ofCode + bits.read(ofCode);
        const mlen = ML_BASE[mlCode] + bits.read(ML_BITS[mlCode]);
        const llen = LL_BASE[llCode] + bits.read(LL_BITS[llCode]);
        // The stream must end exactly at its start; once over-read it is corrupt
        if (bits.left < 0)
            fail('sequence stream over-read');
        let offset;
        if (ofValue > 3) {
            offset = ofValue - 3;
            reps[2] = reps[1];
            reps[1] = reps[0];
            reps[0] = offset;
        }
        else {
            const index = ofValue - 1 + (llen === 0 ? 1 : 0);
            if (index === 0)
                offset = reps[0];
            else {
                offset = index === 3 ? reps[0] - 1 : reps[index];
                if (index !== 1)
                    reps[2] = reps[1];
                reps[1] = reps[0];
                reps[0] = offset;
            }
        }
        if (lit + llen > literals.length)
            fail('literal length past the literals');
        out.bytes(literals, lit, llen);
        lit += llen;
        out.match(offset, mlen);
        if (i < count - 1) {
            sLL = LL.baseline[sLL] + bits.read(LL.bits[sLL]);
            sML = ML.baseline[sML] + bits.read(ML.bits[sML]);
            sOF = OF.baseline[sOF] + bits.read(OF.bits[sOF]);
        }
    }
    if (bits.left !== 0)
        fail('sequence stream not fully consumed');
    out.bytes(literals, lit, literals.length - lit);
}
// ── Frames ────────────────────────────────────────────────────────────────────
const MAGIC = 0xfd2fb528;
const u32 = (d, p) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
/** Decompresses one or more concatenated zstd frames, producing at most `maxBytes`. */
export function zstdDecompress(data, maxBytes = MAX_OUTPUT_BYTES) {
    const out = new Output(data.length * 4, maxBytes);
    let p = 0;
    while (p < data.length) {
        if (p + 4 > data.length)
            fail('truncated');
        const magic = u32(data, p);
        if ((magic & 0xfffffff0) === 0x184d2a50) { // skippable frame
            if (p + 8 > data.length)
                fail('truncated');
            p += 8 + u32(data, p + 4);
            continue;
        }
        if (magic !== MAGIC)
            fail('not a zstd frame');
        p += 4;
        if (p + 1 > data.length)
            fail('truncated frame header');
        const desc = data[p++];
        const fcsFlag = desc >> 6, single = (desc >> 5) & 1, checksum = (desc >> 2) & 1, dictFlag = desc & 3;
        if (desc & 8)
            fail('reserved bit set');
        const headerEnd = p + (single ? 0 : 1) + [0, 1, 2, 4][dictFlag] + [single ? 1 : 0, 2, 4, 8][fcsFlag];
        if (headerEnd > data.length)
            fail('truncated frame header');
        if (!single)
            p++; // window descriptor (the output keeps everything)
        if (dictFlag) {
            const size = [0, 1, 2, 4][dictFlag];
            let id = 0;
            for (let i = size - 1; i >= 0; i--)
                id = id * 256 + data[p + i];
            if (id)
                fail('dictionaries are not supported');
            p += size;
        }
        const fcsSize = [single ? 1 : 0, 2, 4, 8][fcsFlag];
        let stated = -1;
        if (fcsSize) {
            if (fcsSize === 8 && (data[p + 6] || data[p + 7]))
                fail(`output larger than ${maxBytes} bytes`);
            stated = 0;
            for (let i = Math.min(fcsSize, 6) - 1; i >= 0; i--)
                stated = stated * 256 + data[p + i];
            if (fcsSize === 2)
                stated += 256;
            if (out.len + stated > maxBytes)
                fail(`output larger than ${maxBytes} bytes`);
            // A header can claim any size: grow ahead only as far as the input could plausibly reach
            out.reserve(Math.min(stated, data.length * 64));
            p += fcsSize;
        }
        const frameStart = out.len;
        const state = { reps: [1, 4, 8] };
        for (let last = 0; !last;) {
            if (p + 3 > data.length)
                fail('truncated block');
            const h = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);
            p += 3;
            last = h & 1;
            const type = (h >> 1) & 3, size = h >> 3;
            if (type === 0) {
                if (p + size > data.length)
                    fail('truncated block');
                out.bytes(data, p, size);
                p += size;
            }
            else if (type === 1) {
                if (p >= data.length)
                    fail('truncated block');
                out.fill(data[p], size);
                p += 1;
            }
            else if (type === 2) {
                if (p + size > data.length)
                    fail('truncated block');
                decompressBlock(data, p, p + size, out, state);
                p += size;
            }
            else
                fail('reserved block type');
        }
        if (stated >= 0 && out.len - frameStart !== stated)
            fail('frame size does not match its header');
        if (checksum)
            p += 4;
        if (p > data.length)
            fail('truncated');
    }
    return out.buf.slice(0, out.len);
}
/** Whether the bytes start with a zstd frame. */
export const isZstd = (data) => data.length >= 4 && u32(data, 0) === MAGIC;
