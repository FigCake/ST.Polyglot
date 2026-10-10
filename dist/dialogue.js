// ════════════════════════════
// Polyglot  dialogue.ts
// ════════════════════════════
// Finds the dialogue in a message: text inside quotation marks — the lines a
// learner wants to study in "dialogue only" mode, without the narration.
//
//   “Hi,” she said. 「元気？」 "Ciao!" «Salut»
//    ^^^                ^^^^   ^^^^^   ^^^^^   ← line text
//
// Pairs: “” „“ «» 「」 『』 and straight "…". Nested quotes stay inside their
// line (「彼は『はい』と言った」 is one line). An unclosed quote is ignored.
//
// Pure — no DOM.
const CLOSERS = { '“': '”', '„': '“', '«': '»', '「': '」', '『': '』', '"': '"' };
export function dialogueLines(text) {
    const lines = [];
    for (let i = 0; i < text.length; i++) {
        const open = text[i];
        const close = CLOSERS[open];
        if (!close)
            continue;
        let depth = 1, j = i + 1;
        for (; j < text.length; j++) {
            // A closer that is also an opener (straight ") never nests
            if (text[j] === open && open !== close)
                depth++;
            else if (text[j] === close && --depth === 0)
                break;
        }
        if (j >= text.length)
            continue; // unclosed
        if (text.slice(i + 1, j).trim())
            lines.push({ start: i + 1, end: j });
        i = j;
    }
    return lines;
}
/** The lines' text, one per line (what dialogue-only analysis sends to the model). */
export const dialogueText = (text, lines) => lines.map(l => text.slice(l.start, l.end).trim()).join('\n');
