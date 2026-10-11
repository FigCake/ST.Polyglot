// Furigana as data: ruby spans over a message's plain text.
//
//   text ──chunks──▶ AI: [surface, reading] pairs, in order
//        ◀─align──── spans [start, end, reading] over the kanji only
//                    (送り仮名 stays outside the ruby: 食[た]べる, 取[と]り扱[あつか]い)
//
// Pairs are matched in order, so the same word can take different readings
// in different places (今日 as きょう / こんにち). Spans are stored with a
// hash of the text and dropped when the text changes.
//
// Pure — no DOM, no I/O.
// ── Characters ────────────────────────────────────────────────────────────────
const KANJI_CHAR = /[\p{Script=Han}々〆ヵヶ]/u;
const KANJI_RUN = /[\p{Script=Han}々〆ヵヶ]+/gu;
const KANA_ONLY = /^[ぁ-ゖァ-ヺー・]+$/;
export const hasKanji = (text) => KANJI_CHAR.test(text);
export const isKana = (text) => KANA_ONLY.test(text);
/** Katakana → hiragana (ー and ・ are kept). */
export const toHiragana = (text) => text.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
// ── One word ──────────────────────────────────────────────────────────────────
/**
 * Readings for the kanji runs between `literals` (the kana around them) so the
 * whole reading lines up: the first fit with the shortest runs first, which is
 * what a lazy regex ^lit0(.+?)lit1(.+?)…$ finds — but remembering dead ends, so
 * a long reading with many runs takes polynomial time, not exponential.
 */
function fitRuns(literals, hira) {
    if (!hira.startsWith(literals[0]))
        return null;
    const runs = literals.length - 1;
    const out = [];
    const dead = new Set();
    /** Fits run i, which starts at `pos`, and every run after it. */
    const fit = (i, pos) => {
        const key = i * (hira.length + 1) + pos;
        if (dead.has(key))
            return false;
        const next = literals[i + 1];
        for (let end = pos + 1; end + next.length <= hira.length; end++) {
            if (!hira.startsWith(next, end))
                continue;
            const after = end + next.length;
            if (i + 1 === runs ? after === hira.length : fit(i + 1, after)) {
                out[i] = hira.slice(pos, end);
                return true;
            }
        }
        dead.add(key);
        return false;
    };
    return fit(0, literals[0].length) ? out : null;
}
/**
 * Ruby spans for one word, relative to the word: one per run of kanji, with
 * the kana between them matched against the reading.
 *
 *   食べる / たべる           → [[0, 1, 'た']]
 *   取り扱い / とりあつかい   → [[0, 1, 'と'], [2, 3, 'あつか']]
 *   日本語 / にほんご         → [[0, 3, 'にほんご']]
 *
 * When the kana do not line up with the reading, the whole stretch from the
 * first to the last kanji gets one ruby — unless `strict`, which returns no
 * spans instead (for a word card, no reading beats a wrong one).
 */
export function wordSpans(surface, reading, { strict = false } = {}) {
    const hira = toHiragana(reading.replace(/\s+/g, ''));
    const runs = [...surface.matchAll(KANJI_RUN)].map(m => ({ start: m.index, end: m.index + m[0].length }));
    if (!runs.length || !hira || !isKana(hira))
        return [];
    // Everything between the kanji runs must appear literally in the reading
    const literals = [];
    let cursor = 0;
    for (const run of runs) {
        literals.push(toHiragana(surface.slice(cursor, run.start)));
        cursor = run.end;
    }
    literals.push(toHiragana(surface.slice(cursor)));
    const match = fitRuns(literals, hira);
    if (match)
        return runs.map((run, i) => [run.start, run.end, match[i]]);
    if (strict)
        return [];
    // Fallback: one ruby from the first kanji to the last, minus kana shared at both ends
    const start = runs[0].start, end = runs[runs.length - 1].end;
    const lead = toHiragana(surface.slice(0, start));
    const trail = toHiragana(surface.slice(end));
    const inner = hira.startsWith(lead) && hira.endsWith(trail) && hira.length > lead.length + trail.length
        ? hira.slice(lead.length, hira.length - trail.length)
        : hira;
    return [[start, end, inner]];
}
// ── A text ────────────────────────────────────────────────────────────────────
/**
 * Places word readings on text[from, to) in order: each word is looked for
 * after the previous one. Words not found (or without kanji) are skipped
 * without moving on, so one bad pair does not shift the rest.
 */
export function alignReadings(text, words, from = 0, to = text.length) {
    const spans = [];
    let cursor = from;
    for (const [surface, reading] of words) {
        if (!surface || !hasKanji(surface))
            continue;
        const at = text.indexOf(surface, cursor);
        if (at === -1 || at + surface.length > to)
            continue;
        spans.push(...wordSpans(surface, reading).map(([s, e, r]) => [at + s, at + e, r]));
        cursor = at + surface.length;
    }
    return spans;
}
/** Runs of kanji in text[from, to) that no span covers. */
export function kanjiGaps(text, spans, from = 0, to = text.length) {
    const covered = new Set();
    for (const [s, e] of spans)
        for (let i = s; i < e; i++)
            covered.add(i);
    const gaps = [];
    for (let i = from; i < to; i++) {
        if (!KANJI_CHAR.test(text[i]) || covered.has(i))
            continue;
        const last = gaps[gaps.length - 1];
        if (last && last.end === i)
            last.end = i + 1;
        else
            gaps.push({ start: i, end: i + 1 });
    }
    return gaps;
}
/** The uncovered kanji runs as strings. */
export const uncoveredKanji = (text, spans, from = 0, to = text.length) => kanjiGaps(text, spans, from, to).map(g => text.slice(g.start, g.end));
/**
 * A compact word list "暗闇=くらやみ 放=はな …" (space-separated surface=reading),
 * or the array form [["暗闇","くらやみ"], …]. Malformed entries are skipped.
 */
export function parseWordList(v) {
    if (Array.isArray(v)) {
        return v.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string')
            .map(([s, r]) => [s.trim(), r.trim()]);
    }
    if (typeof v !== 'string')
        return [];
    return v.split(/[\s,、]+/).flatMap((entry) => {
        const [surface, reading] = entry.split(/[=＝]/);
        return surface && reading ? [[surface, reading]] : [];
    });
}
/** Sentence ranges of `text`, packed up to `max` characters; only ranges containing kanji. */
export function kanjiChunks(text, max = 400) {
    const sentences = typeof Intl.Segmenter === 'function'
        ? [...new Intl.Segmenter('ja', { granularity: 'sentence' }).segment(text)]
            .map(s => ({ start: s.index, end: s.index + s.segment.length }))
        : [...text.matchAll(/[^。！？!?\n]*[。！？!?\n]?/g)]
            .filter(m => m[0]).map(m => ({ start: m.index, end: m.index + m[0].length }));
    const chunks = [];
    for (const s of sentences) {
        const last = chunks[chunks.length - 1];
        if (last && last.end === s.start && s.end - last.start <= max)
            last.end = s.end;
        else
            chunks.push({ ...s });
    }
    return chunks.filter(c => hasKanji(text.slice(c.start, c.end)));
}
/** A short, stable fingerprint of a text (FNV-1a, 32 bit). */
export function textHash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++)
        h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36) + text.length.toString(36);
}
