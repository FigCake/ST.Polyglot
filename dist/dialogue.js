// Finds the dialogue in a message: text inside quotation marks — the lines a
// learner wants to study in "dialogue only" mode, and the lines the ▶ buttons
// read aloud (ui/line-voice.ts).
//
//   “Hi,” she said. 「元気？」 "Ciao!" «Salut» ‘생각’ 'Ciao, l'amico!'
//    ^^^                ^^^^   ^^^^^   ^^^^^   ^^^^   ^^^^^^^^^^^^^^  ← line text
//
// Quotation marks differ by language, and a chat can switch between them:
//   “…”  English, Korean, Chinese     ‘…’  single (Korean thoughts)
//   „…“  German, Czech                „…”  Polish, Romanian, Hungarian
//   ‚…‘  German single                «…»  French, Italian, Spanish, Russian
//   ‹…›  French single                »…«  ›…‹  German, Danish
//   「…」『…』 Japanese, Chinese      〝…〟 Japanese
//   ”…”  Swedish, Finnish             "…"  '…'  ＂…＂  typed straight
//
// A single quote is also an apostrophe (l'amico, don't, dogs’): it opens a
// line only where a word does not continue before it, and closes one only
// where a word does not continue after it. Lines in single quotes do not run
// past the end of a line of text. Nested quotes stay inside their line
// (「彼は『はい』と言った」 is one line). An unclosed quote is ignored.
//
// Dash dialogue (Spanish, Russian, Polish… novels): a paragraph that starts
// with a dash is speech, and each further dash switches between speech and
// the narrator's words:
//
//   —Hola —dijo ella—. ¿Qué tal?          — Привет, — сказал он. — Как дела?
//    ^^^^               ^^^^^^^^            ^^^^^^^^                ^^^^^^^^^
//
// Paragraphs start after a line break, or at the offsets the caller gives
// (`breaks`: where the message's paragraphs begin in the rendered page).
//
// Pure — no DOM.
/** Each opening mark with the marks that may close it. */
const CLOSERS = {
    '“': '”', '„': '“”', '«': '»', '»': '«', '‹': '›', '›': '‹',
    '「': '」', '『': '』', '〝': '〟〞', '”': '”', '"': '"', '＂': '＂',
    '‘': '’', '‚': '‘’', "'": "'",
};
/** Marks that are also apostrophes or commas: checked against the letters around them. */
const SINGLE = new Set(["'", '‘', '’', '‚']);
const WORD = /[\p{L}\p{M}\p{N}]/u;
const wordAt = (text, i) => i >= 0 && i < text.length && WORD.test(text[i]);
/** `text[i]` can open a line: a single quote not inside or right after a word, and followed by text. */
function opens(text, i) {
    if (!SINGLE.has(text[i]))
        return true;
    return !wordAt(text, i - 1) && i + 1 < text.length && !/\s/.test(text[i + 1]);
}
/** `text[i]` can close a line: a single quote after text and not followed by a word. */
function closes(text, i) {
    if (!SINGLE.has(text[i]))
        return true;
    return i > 0 && !/\s/.test(text[i - 1]) && !wordAt(text, i + 1);
}
const DASHES = '—–―';
/** A dash that opens speech: followed by a word, an opening ¿ ¡ or quotation mark, after at most one space. */
const SPEECH_DASH = /[—–―] ?[\p{L}\p{N}¿¡«“"]/uy;
/** What a piece of speech after the narrator's words starts with: the narrator's punctuation. */
const LEAD = /^[\s.,;:]+/u;
/** Whether a paragraph starts at `i` (only spaces before it since the line break or the paragraph's start). */
function paragraphStart(text, i, breaks) {
    let k = i;
    while (breaks?.has(k) !== true && k > 0 && /[ \t\u00a0]/.test(text[k - 1]))
        k--;
    return k === 0 || text[k - 1] === '\n' || breaks?.has(k) === true;
}
/** Where the paragraph that holds `i` ends. */
function paragraphEnd(text, i, breaks) {
    let end = text.indexOf('\n', i);
    if (end === -1)
        end = text.length;
    for (const b of breaks ?? [])
        if (b > i && b < end)
            end = b;
    return end;
}
/** The speech of a paragraph that starts with a dash at `i`: every other piece between dashes. */
function dashLines(text, i, end) {
    const lines = [];
    let speech = true, from = i + 1;
    for (let j = i + 1; j <= end; j++) {
        if (j < end && !DASHES.includes(text[j]))
            continue;
        if (speech) {
            const piece = text.slice(from, j);
            const start = from + (piece.match(LEAD)?.[0].length ?? 0);
            const stop = from + piece.trimEnd().length;
            if (stop > start)
                lines.push({ start, end: stop, after: stop });
        }
        speech = !speech;
        from = j + 1;
    }
    return lines;
}
export function dialogueLines(text, breaks) {
    const lines = [];
    for (let i = 0; i < text.length; i++) {
        const open = text[i];
        if (DASHES.includes(open)) {
            SPEECH_DASH.lastIndex = i;
            if (!SPEECH_DASH.test(text) || !paragraphStart(text, i, breaks))
                continue;
            // The whole paragraph is read this way: quotation marks in it are not lines of their own
            const end = paragraphEnd(text, i, breaks);
            lines.push(...dashLines(text, i, end));
            i = end - 1;
            continue;
        }
        const closer = CLOSERS[open];
        if (!closer || !opens(text, i))
            continue;
        const single = SINGLE.has(open);
        let depth = 1, j = i + 1;
        for (; j < text.length; j++) {
            const c = text[j];
            if (single && c === '\n') {
                j = text.length;
                break;
            }
            // A mark that closes as well as opens (straight ") never nests
            if (c === open && !closer.includes(open) && opens(text, j))
                depth++;
            else if (closer.includes(c) && closes(text, j) && --depth === 0)
                break;
        }
        if (j >= text.length)
            continue; // unclosed
        if (text.slice(i + 1, j).trim())
            lines.push({ start: i + 1, end: j, after: j + 1 });
        i = j;
    }
    return lines;
}
/** The lines' text, one per line (what dialogue-only analysis sends to the model). */
export const dialogueText = (text, lines) => lines.map(l => text.slice(l.start, l.end).trim()).join('\n');
