// ════════════════════════════
// Polyglot  zip.ts
// ════════════════════════════
// Zip files: Anki packages (.apkg / .colpkg) and backups with media.
//
//   readZip / readEntry   reads entries without loading the whole file: the
//                         central directory is read from the end, and each
//                         entry is sliced out and inflated (DecompressionStream)
//                         only when asked for. Stored and deflated; zip64.
//   buildZip              writes stored (uncompressed) entries as a Blob —
//                         media is compressed already; JSON is small.
export class ZipError extends Error {
}
const fail = (why) => { throw new ZipError(`zip: ${why}`); };
const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;
async function bytesOf(file, start, end) {
    return new DataView(await file.slice(start, end).arrayBuffer());
}
const u64 = (v, p) => v.getUint32(p, true) + v.getUint32(p + 4, true) * 2 ** 32;
/** The entries of a zip file, by name. */
export async function readZip(file) {
    // End of central directory: the last 22 bytes, or before a comment (≤ 64 KB)
    const tailStart = Math.max(0, file.size - 22 - 0xffff);
    const tail = await bytesOf(file, tailStart, file.size);
    let eocd = -1;
    for (let p = tail.byteLength - 22; p >= 0; p--)
        if (tail.getUint32(p, true) === EOCD) {
            eocd = p;
            break;
        }
    if (eocd < 0)
        fail('not a zip file');
    let count = tail.getUint16(eocd + 10, true);
    let size = tail.getUint32(eocd + 12, true);
    let offset = tail.getUint32(eocd + 16, true);
    if (count === 0xffff || size === MAX32 || offset === MAX32) {
        const loc = eocd - 20;
        if (loc < 0 || tail.getUint32(loc, true) !== LOCATOR64)
            fail('zip64 locator missing');
        const at = u64(tail, loc + 8);
        const rec = await bytesOf(file, at, at + 56);
        if (rec.getUint32(0, true) !== EOCD64)
            fail('zip64 record missing');
        count = u64(rec, 32);
        size = u64(rec, 40);
        offset = u64(rec, 48);
    }
    const dir = await bytesOf(file, offset, offset + size);
    const names = new TextDecoder();
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
        if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== CENTRAL)
            fail('bad central directory');
        const method = dir.getUint16(p + 10, true);
        let compressed = dir.getUint32(p + 20, true);
        let sizeOf = dir.getUint32(p + 24, true);
        const nameLen = dir.getUint16(p + 28, true);
        const extraLen = dir.getUint16(p + 30, true);
        const comment = dir.getUint16(p + 32, true);
        let local = dir.getUint32(p + 42, true);
        const name = names.decode(new Uint8Array(dir.buffer, p + 46, nameLen));
        // Zip64 extra field: the 32-bit values that overflowed, in this order
        for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
            const id = dir.getUint16(e, true), len = dir.getUint16(e + 2, true);
            if (id === 1) {
                let q = e + 4;
                if (sizeOf === MAX32) {
                    sizeOf = u64(dir, q);
                    q += 8;
                }
                if (compressed === MAX32) {
                    compressed = u64(dir, q);
                    q += 8;
                }
                if (local === MAX32) {
                    local = u64(dir, q);
                }
            }
            e += 4 + len;
        }
        entries.set(name, { name, method, compressed, size: sizeOf, offset: local });
        p += 46 + nameLen + extraLen + comment;
    }
    return entries;
}
/** An entry's bytes, inflated. */
export async function readEntry(file, entry) {
    const head = await bytesOf(file, entry.offset, entry.offset + 30);
    if (head.getUint32(0, true) !== LOCAL)
        fail(`bad local header for ${entry.name}`);
    const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const data = file.slice(start, start + entry.compressed);
    if (entry.method === 0)
        return new Uint8Array(await data.arrayBuffer());
    if (entry.method !== 8)
        fail(`unsupported compression ${entry.method} for ${entry.name}`);
    const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
// ── Writing ───────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();
export function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++)
        c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
/** A zip of stored entries (no zip64: each entry and the whole file stay under 4 GB). */
export function buildZip(files) {
    const parts = [];
    const central = [];
    const encoder = new TextEncoder();
    let offset = 0;
    for (const { name, data } of files) {
        const nameBytes = encoder.encode(name);
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, LOCAL, true);
        local.setUint16(4, 20, true); // version needed
        local.setUint16(6, 0x0800, true); // UTF-8 names
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, nameBytes.length, true);
        parts.push(local.buffer, nameBytes, data);
        const entry = new DataView(new ArrayBuffer(46));
        entry.setUint32(0, CENTRAL, true);
        entry.setUint16(4, 20, true);
        entry.setUint16(6, 20, true);
        entry.setUint16(8, 0x0800, true);
        entry.setUint32(16, crc, true);
        entry.setUint32(20, data.length, true);
        entry.setUint32(24, data.length, true);
        entry.setUint16(28, nameBytes.length, true);
        entry.setUint32(42, offset, true);
        central.push(new Uint8Array(entry.buffer), nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const size = central.reduce((n, b) => n + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, EOCD, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
