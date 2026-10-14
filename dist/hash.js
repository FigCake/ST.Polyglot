// FNV-1a over a string's UTF-16 code units: a stable 32-bit number for picks
// and fingerprints (not for security). Pure.
export function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++)
        h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h >>> 0;
}
