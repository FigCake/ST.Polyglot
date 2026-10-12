// SHA-1 of a UTF-8 string, as hex. Anki keys duplicate checks on it (a note's
// checksum is the first 8 hex digits of its first field's SHA-1). Written out
// because crypto.subtle exists only on secure pages, and SillyTavern is often
// opened over plain http from another device on the network.
//
// Pure — no DOM, no I/O.
export function sha1Hex(text) {
    const bytes = new TextEncoder().encode(text);
    // Message + 0x80 + zero padding + 64-bit length, in 64-byte blocks
    const length = (((bytes.length + 8) >> 6) + 1) << 6;
    const data = new Uint8Array(length);
    data.set(bytes);
    data[bytes.length] = 0x80;
    const view = new DataView(data.buffer);
    view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(length - 4, (bytes.length * 8) >>> 0);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Uint32Array(80);
    const rotl = (x, n) => (x << n) | (x >>> (32 - n));
    for (let block = 0; block < length; block += 64) {
        for (let i = 0; i < 16; i++)
            w[i] = view.getUint32(block + i * 4);
        for (let i = 16; i < 80; i++)
            w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        let a = h0, b = h1, c = h2, d = h3, e = h4;
        for (let i = 0; i < 80; i++) {
            const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999]
                : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
                    : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
                        : [b ^ c ^ d, 0xca62c1d6];
            const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
            e = d;
            d = c;
            c = rotl(b, 30) >>> 0;
            b = a;
            a = t;
        }
        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
    }
    return [h0, h1, h2, h3, h4].map(h => h.toString(16).padStart(8, '0')).join('');
}
