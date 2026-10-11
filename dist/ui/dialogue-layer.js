// "Dialogue only" decoration on a message (the first decor layer): each line
// of dialogue is marked. Double-clicking (or the touch [Translate sentence])
// inside a marked line translates the whole line (ui/tap-translate.ts).
//
// Lines are found in the plain text (plain-text.ts, dialogue.ts); marks wrap
// text nodes only, so the plain text — and the offsets furigana and
// highlights use — stay the same.
import { plainText, plainTextNodes } from '../plain-text.js';
import { dialogueLines } from '../dialogue.js';
import { DECOR_CLASS } from './message-decor.js';
export const LINE_CLASS = 'pg-dlg';
/** Marks the dialogue lines. */
export function drawDialogue(textEl) {
    const lines = dialogueLines(plainText(textEl));
    if (!lines.length)
        return;
    let offset = 0;
    for (const node of plainTextNodes(textEl)) {
        const start = offset, end = offset + node.data.length;
        offset = end;
        if (node.parentElement?.closest('code, pre'))
            continue;
        if (!lines.some(l => l.start < end && l.end > start))
            continue;
        // Cut at the line edges inside this node
        const cuts = [...new Set([
                start, end,
                ...lines.flatMap(l => [l.start, l.end]).filter(p => p > start && p < end),
            ])].sort((a, b) => a - b);
        const inLine = (a, b) => lines.some(l => a >= l.start && b <= l.end);
        const frag = document.createDocumentFragment();
        for (let k = 0; k < cuts.length - 1; k++) {
            const [a, b] = [cuts[k], cuts[k + 1]];
            const piece = node.data.slice(a - start, b - start);
            if (inLine(a, b)) {
                const mark = document.createElement('span');
                mark.className = `${LINE_CLASS} ${DECOR_CLASS}`;
                mark.textContent = piece;
                frag.append(mark);
            }
            else {
                frag.append(piece);
            }
        }
        node.replaceWith(frag);
    }
}
export function stripDialogue(textEl) {
    textEl.querySelectorAll(`.${LINE_CLASS}`).forEach(s => s.replaceWith(...s.childNodes));
    textEl.normalize();
}
