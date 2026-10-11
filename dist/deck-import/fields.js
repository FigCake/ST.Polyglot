// From Anki notes to wordbook rows.
//
//   field HTML ─▶ text           tags removed, entities decoded, <br> → space
//              ─▶ media refs     [sound:x.mp3]  <img src="x.png">
//   日本語[にほんご] (Anki furigana) ─▶ 日本語 + reading にほんご
//
// A mapping says which field is the word, the meaning, …; guessMapping()
// proposes one from the field names, the user can change it.
//
// Pure — no DOM, no I/O.
// ── Field text ────────────────────────────────────────────────────────────────
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#')
        return NAMED[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
/** A field's visible text: no media, no tags, no ruby readings, single-spaced. */
export const fieldText = (html) => decodeEntities(html
    .replace(/\[sound:[^\]]*\]/gi, ' ')
    .replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(div|p|li)>/gi, ' ')
    .replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
/** Media a field refers to, in order. */
export function mediaRefs(html) {
    const sounds = [...html.matchAll(/\[sound:([^\]]+)\]/gi)].map(m => decodeEntities(m[1].trim()));
    const images = [...html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
        .map(m => decodeEntities((m[1] ?? m[2] ?? m[3]).trim()))
        .filter(src => src && !/^(https?:|data:)/i.test(src));
    return { sounds, images };
}
// ── Anki furigana: 漢字[かんじ] ───────────────────────────────────────────────
const FURIGANA = / ?([^\s[\]]+?)\[([^\]]+)\]/g;
export const hasFurigana = (text) => /[^\s[\]]\[[^\]]+\]/.test(text);
/** Ruby HTML as Anki furigana: <ruby>漢字<rt>かんじ</rt></ruby> → 漢字[かんじ] (then read by splitFurigana). */
export const rubyToFurigana = (html) => html.replace(/<ruby\b[^>]*>([\s\S]*?)<\/ruby>/gi, (_, inner) => inner
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
    .replace(/([^<]*)<rt\b[^>]*>([\s\S]*?)<\/rt>/gi, (_m, base, rt) => `${base.trim()}[${rt.trim()}]`));
/** "食[た]べる" → { text: "食べる", reading: "たべる" } (plain text: reading = ''). */
export function splitFurigana(text) {
    if (!hasFurigana(text))
        return { text, reading: '' };
    // In "X[r]" the reading covers the whole run before the bracket (kanji, sometimes with kana)
    return {
        text: text.replace(FURIGANA, '$1'),
        reading: text.replace(FURIGANA, '$2'),
    };
}
export const TARGETS = ['word', 'meaning', 'reading', 'example', 'notes'];
const NAME_HINTS = [
    ['reading', /reading|kana|furigana|hiragana|pronunciation|pinyin|romaji|ipa|発音|読み|よみ|읽기|발음/i],
    ['example', /example|sentence|context|usage|esempio|ejemplo|frase|例文|例|예문/i],
    ['meaning', /meaning|definition|translation|gloss|english|back|answer|significato|significado|traducci|意味|訳|뜻|의미|번역/i],
    ['word', /^(word|vocab|vocabulary|expression|term|front|question|kanji|lemma|parola|palabra|単語|語彙|단어|표현)/i],
    ['notes', /note|extra|comment|memo|hint|メモ|備考|메모/i],
];
/** A first guess from the field names: hints first, then the first two unused fields. */
export function guessMapping(fields) {
    const map = { word: -1, meaning: -1, reading: -1, example: -1, notes: -1 };
    const used = new Set();
    for (const [target, re] of NAME_HINTS) {
        const i = fields.findIndex((f, k) => !used.has(k) && re.test(f.trim()));
        if (i >= 0) {
            map[target] = i;
            used.add(i);
        }
    }
    const free = () => fields.findIndex((_, k) => !used.has(k));
    if (map.word < 0) {
        map.word = free();
        if (map.word >= 0)
            used.add(map.word);
    }
    if (map.meaning < 0) {
        map.meaning = free();
        if (map.meaning >= 0)
            used.add(map.meaning);
    }
    return map;
}
/** Wordbook rows from the notes of the chosen note types; notes without a word are skipped. */
export function notesToRows(notes, mappings) {
    const rows = [];
    for (const note of notes) {
        const map = mappings.get(note.typeId);
        if (!map)
            continue;
        const html = (t) => (map[t] >= 0 ? rubyToFurigana(note.fields[map[t]] ?? '') : '');
        const word = splitFurigana(fieldText(html('word')));
        if (!word.text)
            continue;
        const refs = note.fields.map(mediaRefs);
        const row = {
            word: word.text,
            meaning: splitFurigana(fieldText(html('meaning'))).text,
            deck: note.deck,
        };
        // A Reading field holds kana, or furigana (日本語[にほんご]) whose reading is the part wanted
        const readingField = splitFurigana(fieldText(html('reading')));
        const reading = readingField.reading || readingField.text || word.reading;
        const example = splitFurigana(fieldText(html('example'))).text;
        const notesText = fieldText(html('notes'));
        const sound = refs.flatMap(r => r.sounds)[0];
        const image = refs.flatMap(r => r.images)[0];
        if (reading)
            row.reading = reading;
        if (example)
            row.example = example;
        if (notesText)
            row.notes = notesText;
        if (sound)
            row.sound = sound;
        if (image)
            row.image = image;
        rows.push(row);
    }
    return rows;
}
/** Note types that have notes, with a guessed mapping and a sample note. */
export function describeTypes(types, notes) {
    return types.map(type => {
        const own = notes.filter(n => n.typeId === type.id);
        return { type, count: own.length, sample: own[0], mapping: guessMapping(type.fields) };
    }).filter(d => d.count > 0);
}
