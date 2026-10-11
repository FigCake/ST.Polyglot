// Draws ruby spans onto a message's text nodes and removes them again.
//
//   plain text   今日は晴れ            (plain-text.ts: no readings, no bubbles)
//   spans        [0,2,きょう] [3,4,は]
//   DOM          <ruby class="pg-ruby pg-decor">今日<rp>(</rp><rt>きょう</rt><rp>)</rp></ruby>は…
//
// Spans are placed by offset in the plain text, so they land inside
// highlight spans as well. A span split across elements (e.g. 今<em>日</em>)
// is skipped. Text in <code> / <pre> is left alone.
import { plainTextNodes } from '../plain-text.js';
import { DECOR_CLASS } from '../ui/message-decor.js';
export const RUBY_CLASS = 'pg-ruby';
function rubyElement(base, reading, index) {
    const ruby = document.createElement('ruby');
    ruby.className = `${RUBY_CLASS} ${DECOR_CLASS}`;
    ruby.dataset.pgSpan = String(index);
    const rt = document.createElement('rt');
    rt.textContent = reading;
    // <rp> shows "(reading)" in browsers without ruby support; hidden otherwise
    ruby.append(base, Object.assign(document.createElement('rp'), { textContent: '(' }), rt, Object.assign(document.createElement('rp'), { textContent: ')' }));
    return ruby;
}
/** Wraps the spans' kanji in <ruby>. `spans` must be sorted by start. */
export function drawRuby(textEl, spans) {
    let next = 0;
    let offset = 0;
    for (const node of plainTextNodes(textEl)) {
        const start = offset, end = offset + node.data.length;
        offset = end;
        while (next < spans.length && spans[next][0] < start)
            next++;
        if (next >= spans.length)
            break;
        if (spans[next][0] >= end || node.parentElement?.closest('code, pre, ruby'))
            continue;
        const frag = document.createDocumentFragment();
        let cursor = start;
        for (; next < spans.length && spans[next][1] <= end; next++) {
            const [s, e, reading] = spans[next];
            if (s < cursor)
                continue; // overlaps the previous span
            if (s > cursor)
                frag.append(node.data.slice(cursor - start, s - start));
            frag.append(rubyElement(node.data.slice(s - start, e - start), reading, next));
            cursor = e;
        }
        if (cursor === start)
            continue; // only a span that runs past this node
        if (cursor < end)
            frag.append(node.data.slice(cursor - start));
        node.replaceWith(frag);
    }
}
/** Replaces every ruby with its base text. */
export function stripRuby(textEl) {
    const rubies = textEl.querySelectorAll(`ruby.${RUBY_CLASS}`);
    if (!rubies.length)
        return;
    rubies.forEach(ruby => {
        ruby.querySelectorAll('rt, rp').forEach(el => el.remove());
        ruby.replaceWith(...ruby.childNodes);
    });
    textEl.normalize();
}
