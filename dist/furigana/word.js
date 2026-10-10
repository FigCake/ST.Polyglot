// ════════════════════════════
// Polyglot  furigana/word.ts
// ════════════════════════════
// A single word with its reading as ruby markup — for word cards, the
// wordbook list, flashcards, the PDF deck and tap-translation chips.
//
// Dependencies: html.ts, utils.ts, runtime.ts, furigana/model.ts
import { html } from '../html.js';
import { isKana, wordSpans } from './model.js';
import { isJapanese } from '../utils.js';
import { getSettings, getLang } from '../runtime.js';
/**
 * The kana reading of a word, if it has one. Older Japanese entries keep
 * their reading in `ipa` (re-analysis writes hiragana there), so both are read.
 */
export function readingOf(e) {
    for (const candidate of [e.reading, e.ipa]) {
        const r = candidate?.trim();
        if (r && isKana(r))
            return r;
    }
    return undefined;
}
/** The reading to display: none while furigana is off (or the study language is not Japanese). */
export function shownReading(e) {
    if (!isJapanese(getLang()) || getSettings().furigana_enabled === false)
        return undefined;
    return readingOf(e);
}
/**
 * The word with ruby over its kanji (okurigana outside); the plain word when
 * the reading does not fit it (a model may give the reading of another form:
 * 巨大な's reading for 巨大だ) — on a word card no reading beats a wrong one.
 */
export function rubyWord(word, reading) {
    const spans = reading ? wordSpans(word, reading, { strict: true }) : [];
    if (!spans.length)
        return html `${word}`;
    const parts = [];
    let cursor = 0;
    for (const [start, end, r] of spans) {
        parts.push(html `${word.slice(cursor, start)}<ruby class="pg-ruby">${word.slice(start, end)}<rt>${r}</rt></ruby>`);
        cursor = end;
    }
    return html `${parts}${word.slice(cursor)}`;
}
