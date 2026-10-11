// Asks the model for the readings of a text and turns them into ruby spans.
//
//   text ─▶ kanji chunks ─▶ ONE request (words back as "surface=reading …")
//                               │
//                          align each chunk ─▶ spans (+ the kanji left uncovered)
//
// One request per message, however long: a longer reply takes longer, but a
// long message's analysis (sent at the same time) takes longer still.
import { furiganaPrompt } from '../prompts.js';
import { isRecord, unionBy } from '../ai/client.js';
import { alignReadings, hasKanji, kanjiChunks, kanjiGaps, parseWordList, } from './model.js';
function acceptPassages(v) {
    if (!isRecord(v) || !Array.isArray(v.passages))
        return null;
    const passages = v.passages
        .filter((p) => isRecord(p) && Number.isInteger(p.i))
        .map(p => ({ i: p.i, words: parseWordList(p.words) }));
    return passages.length ? passages : null;
}
/**
 * Readings for every kanji in `text` (or only inside `ranges`, e.g. dialogue
 * lines), as ruby spans over the whole text.
 */
export async function fetchReadings(text, ai, signal, ranges) {
    const chunks = ranges
        ? ranges.filter(r => hasKanji(text.slice(r.start, r.end)))
        : kanjiChunks(text);
    const spans = [];
    if (chunks.length) {
        const { data } = await ai.json({
            prompt: furiganaPrompt(chunks.map((c, i) => ({ i, text: text.slice(c.start, c.end) }))),
            signal,
            accept: acceptPassages,
            merge: unionBy(p => String(p.i)),
        });
        for (const passage of data) {
            const chunk = chunks[passage.i];
            if (chunk)
                spans.push(...alignReadings(text, passage.words, chunk.start, chunk.end));
        }
        spans.sort((a, b) => a[0] - b[0]);
    }
    const uncovered = (ranges ?? [{ start: 0, end: text.length }])
        .flatMap(r => kanjiGaps(text, spans, r.start, r.end))
        .map(g => text.slice(g.start, g.end));
    return { spans, uncovered };
}
