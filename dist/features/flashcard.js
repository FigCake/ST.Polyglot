// Flashcards: browse mode, or review mode (FSRS, srs.ts): today's due words
// first, then new words up to the day's limit (setting srs_new_per_day).
//
//   front  word · part of speech · 🔊 · 🎤 pronunciation check
//   back   meaning · base form · meaning in context · example sentence · note
//
// In review mode a learnt word may instead be asked as its example with the
// word blanked, or as its meaning with the word to type (card-kind.ts).
//
// Example sentences are generated once, on the first flip of a card without
// one, and saved to the entry.
//
// Design rules:
//   • ST state and runtime helpers come in through FlashDeps.
//   • One delegated click handler per session; re-rendering a card never re-binds.
import { exampleSentencePrompt, EXAMPLE_FIELDS } from '../prompts.js';
import { shuffleArray } from '../utils.js';
import { rubyWord, shownReading } from '../furigana/word.js';
import { html, setHtml, raw } from '../html.js';
import { t, currentLang } from '../i18n.js';
import { loadWordbook, saveWordbook, scopedWordbook, getSets, setKnown } from '../wordbook.js';
import { srsRate, previewDays, todaysCards, forecast, isNew, isFresh, isMissed, isCard } from '../srs.js';
import { logReview, newWordsToday } from '../study-log.js';
import { cardKind, clozeOf, gradeWord } from '../card-kind.js';
import { findWord } from '../utils.js';
import { acceptObject, missingKeys } from '../ai/client.js';
import { userFileUrl } from '../user-files.js';
import { withoutSound } from '../word-sounds.js';
import { speakButton } from '../speak-button.js';
const RATINGS = [
    { rating: 0, key: 'fl.again', cls: 'pg-srs-again' },
    { rating: 1, key: 'fl.hard', cls: 'pg-srs-hard' },
    { rating: 2, key: 'fl.good', cls: 'pg-srs-good' },
    { rating: 3, key: 'fl.easy', cls: 'pg-srs-easy' },
];
/** How many more new words "more new words" adds to today's. */
const MORE_NEW = 10;
/** An interval as a button label: "3d", "1.5mo", "2y" (in the UI language). */
function intervalLabel(days) {
    // 1.5 / 1,5 by the UI language
    const short = (n) => (n < 10 ? Math.round(n * 10) / 10 : Math.round(n)).toLocaleString(currentLang());
    if (days < 30)
        return t('fl.ivlDays', { n: days });
    if (days < 365)
        return t('fl.ivlMonths', { n: short(days / 30) });
    return t('fl.ivlYears', { n: short(days / 365) });
}
/** The four rating buttons, each with the interval it gives, and "I know this word". */
function ratingRow(days) {
    return html `
        <div class="pg-srs-rating">${RATINGS.map(r => html `
            <button class="pg-srs-btn ${r.cls}" data-action="rate" data-rating="${r.rating}">
                <span class="pg-srs-label">${t(r.key)}</span>
                <span class="pg-srs-preview">${r.rating === 0 ? t('fl.ivlSoon') : intervalLabel(days[r.rating])}</span>
            </button>`)}
        </div>
        <button class="pg-srs-known" data-action="set-known" title="${t('wb.markKnown')}">${t('fl.knowIt')}</button>`;
}
const multiline = (text) => html `${text.split('\n').map((line, i) => html `${i > 0 && raw('<br>')}${line}`)}`;
// ── Example sentences ─────────────────────────────────────────────────────────
let exampleRequest = null;
/** The example with the word marked (or blanked, on a cloze card's front). */
function sentenceView(c, blank = false) {
    return blank
        ? html `${c.parts.map((part, i) => html `${i > 0 && html `<span class="pg-cloze-blank" aria-label="${t('qz.typedBlank')}"></span>`}${part}`)}`
        : html `${c.parts.map((part, i) => html `${i > 0 && html `<b class="pg-cloze-answer">${c.answer}</b>`}${part}`)}`;
}
function exampleView(w) {
    if (!w.example)
        return html `
        <div class="pg-flash-example-wrap">
            <div class="pg-flash-example pg-flash-example-loading"><i class="fa-solid fa-spinner fa-spin"></i></div>
        </div>`;
    const cloze = clozeOf(w);
    return html `
        <div class="pg-flash-example-wrap">
            <div class="pg-flash-example">${cloze ? sentenceView(cloze) : w.example}
                ${speakButton({ saved: !!w.example_audio, label: t('fl.listenExample'), cls: 'pg-flash-example-speak', action: 'speak-example' })}</div>
            ${w.example_translation && html `<div class="pg-flash-example-trans">${w.example_translation}</div>`}
        </div>`;
}
/** Generates and saves an example for `w`, then updates the card's example slot in place. */
async function loadExample(w, card, deps) {
    exampleRequest?.abort();
    const request = new AbortController();
    exampleRequest = request;
    const slot = card.querySelector('.pg-flash-example-wrap');
    try {
        const { data } = await deps.ai.json({
            prompt: exampleSentencePrompt(w.base_form || w.word, deps.getLang(), deps.getSettings().cefr_level, deps.getNativeLang()),
            signal: request.signal,
            accept: (acceptObject),
            missing: v => missingKeys(v, EXAMPLE_FIELDS),
        });
        const sentence = data.sentence?.trim();
        if (request.signal.aborted || !sentence)
            return;
        // Re-read so concurrent SRS updates are not overwritten
        const wordbook = loadWordbook();
        const i = wordbook.findIndex(e => e.word === w.word);
        const translation = data.translation?.trim() || undefined;
        // Kept only when the sentence really has it
        const form = typeof data.form === 'string' && findWord(sentence, data.form.trim()) !== -1 ? data.form.trim() : undefined;
        if (i >= 0) {
            const entry = { ...wordbook[i], example: sentence, example_translation: translation ?? wordbook[i].example_translation };
            if (form)
                entry.example_form = form;
            else
                delete entry.example_form;
            // A new example: the old one's sound no longer fits (its file goes at the next save)
            wordbook[i] = withoutSound(entry, 'example_audio');
            saveWordbook(wordbook);
        }
        Object.assign(w, { example: sentence, example_translation: translation ?? w.example_translation });
        if (form)
            w.example_form = form;
        else
            delete w.example_form;
        delete w.example_audio;
        if (slot?.isConnected)
            slot.outerHTML = exampleView(w).value;
    }
    catch {
        if (request.signal.aborted || !slot?.isConnected)
            return;
        setHtml(slot, html `<div class="pg-flash-example pg-flash-example-err">—</div>`);
    }
    finally {
        if (exampleRequest === request)
            exampleRequest = null;
    }
}
// ── Session ───────────────────────────────────────────────────────────────────
class FlashcardSession {
    root;
    deps;
    deck = [];
    index = 0;
    flipped = false;
    srs = false;
    reviewed = 0;
    /** New words added to today's limit this session ("more new words"). */
    extraNew = 0;
    /** The kind each card was first shown as, by word and review time (it must not change while shown). */
    kinds = new Map();
    /** The answer typed on a typing card, once checked. */
    typed = null;
    setSelect;
    area;
    constructor(root, deps, review) {
        this.root = root;
        this.deps = deps;
        this.srs = review;
        setHtml(root, html `
            <div class="pg-flash-controls">
                <select class="pg-set-select pg-flash-set" aria-label="${t('fl.allWords')}">
                    <option value="all">${t('fl.allWords')}</option>
                    ${getSets().map(s => html `<option value="${s.id}">${s.name}</option>`)}
                </select>
                <button class="pg-btn pg-btn-secondary pg-srs-toggle" data-action="toggle-srs" title="${t('fl.srsTitle')}">
                    🔁 SRS <span class="pg-srs-badge" hidden>0</span>
                </button>
                <button class="pg-btn pg-btn-secondary pg-flash-shuffle" data-action="shuffle" title="${t('fl.shuffle')}">🔀</button>
            </div>
            <div class="pg-flash-area"></div>`);
        this.setSelect = root.querySelector('.pg-flash-set');
        this.area = root.querySelector('.pg-flash-area');
        root.addEventListener('click', e => this.onClick(e));
        // The typed answer is a form: Enter and a phone keyboard's Go / Done both submit it
        root.addEventListener('submit', e => {
            if (!e.target.matches?.('.pg-flash-type'))
                return;
            e.preventDefault();
            this.check();
        });
        this.setSelect.addEventListener('change', () => this.restart());
        this.restart();
    }
    get card() { return this.deck[this.index]; }
    /** How the shown card asks for its word: fixed when it is first shown. */
    kindOf(w) {
        if (!this.srs)
            return 'meaning';
        const key = `${w.word}\n${w.srs_reviewed_at ?? 0}`;
        let kind = this.kinds.get(key);
        if (!kind)
            this.kinds.set(key, kind = cardKind(w));
        return kind;
    }
    pool() {
        const setId = this.setSelect.value;
        return scopedWordbook().filter(w => isCard(w) && (setId === 'all' || (w.setIds ?? []).includes(setId)));
    }
    /** New words still to start today. */
    newLeft() {
        const limit = this.deps.getSettings().srs_new_per_day ?? 20;
        return Math.max(0, limit + this.extraNew - newWordsToday());
    }
    /** Rebuilds the deck from the current set and mode, and shows its first card. */
    restart() {
        const pool = this.pool();
        this.deck = this.srs ? todaysCards(pool, this.newLeft()) : pool;
        this.index = 0;
        this.flipped = false;
        this.typed = null;
        this.reviewed = 0;
        this.updateControls(pool);
        this.render();
    }
    updateControls(pool = this.pool()) {
        const today = this.srs ? this.deck.length : todaysCards(pool, this.newLeft()).length;
        const badge = this.root.querySelector('.pg-srs-badge');
        if (badge) {
            badge.textContent = String(today);
            badge.hidden = today === 0;
        }
        this.root.querySelector('.pg-srs-toggle')?.classList.toggle('pg-srs-active', this.srs);
        const shuffle = this.root.querySelector('.pg-flash-shuffle');
        if (shuffle)
            shuffle.disabled = this.srs;
    }
    // ── Views ─────────────────────────────────────────────────────────────────
    emptyView() {
        if (!this.srs)
            return html `<div class="pg-empty-hint">${multiline(t('fl.noWords'))}</div>`;
        const pool = this.pool();
        const ahead = forecast(pool);
        const more = pool.some(isFresh);
        return html `
            <div class="pg-srs-complete">
                <div class="pg-srs-complete-icon">🎉</div>
                <div class="pg-srs-complete-title">${t('fl.allDone')}</div>
                <div class="pg-srs-complete-sub">${t('fl.allDoneSub', { n: this.reviewed })}</div>
                <div class="pg-srs-forecast">${t('fl.forecast', { tomorrow: ahead.tomorrow, week: ahead.week })}</div>
                ${more && html `<button class="pg-btn pg-btn-secondary pg-btn-full" data-action="more-new">${t('fl.moreNew', { n: MORE_NEW })}</button>`}
                <button class="pg-btn pg-btn-secondary pg-btn-full" data-action="browse-all">${t('fl.backAll')}</button>
            </div>`;
    }
    cardView(w) {
        const { flipped, srs } = this;
        const progress = srs
            ? `${t('fl.remaining', { n: this.deck.length })} · ${t('fl.doneSess', { n: this.reviewed })}`
            : `${this.index + 1} / ${this.deck.length}`;
        const days = srs && flipped ? previewDays(w) : [];
        const kind = this.kindOf(w);
        if (kind !== 'meaning')
            return this.askView(w, kind, progress, days);
        return html `
            <div class="pg-flash-progress">${srs && isNew(w) && html `<span class="pg-srs-new">${t('fl.newBadge')}</span> `}${isMissed(w) && html `<span class="pg-srs-new pg-missed-tag">${t('wb.missedTag')}</span> `}${progress}</div>
            <div class="pg-flash-card ${flipped && 'pg-flash-flipped'}" data-action="flip">
                <div class="pg-flash-front">
                    <div class="pg-flash-word">${rubyWord(w.word, shownReading(w))}</div>
                    ${w.pos_info && html `<div class="pg-flash-pos">${w.pos_info}</div>`}
                    <div class="pg-flash-btn-row">
                        ${speakButton({ saved: !!w.audio, label: t('fl.listen'), cls: 'pg-flash-speak', action: 'speak' })}
                        ${this.deps.hasSpeechRecog() && html `<button class="pg-flash-mic" data-action="mic" title="${t('fl.mic')}" data-active="false">🎤</button>`}
                    </div>
                </div>
                <div class="pg-flash-back">
                    ${flipped && w.image && html `<img class="pg-word-img" src="${userFileUrl(w.image)}" alt="">`}
                    <div class="pg-flash-meaning">${w.meaning}</div>
                    ${w.base_form && w.base_form !== w.word && html `<div class="pg-flash-pos">${w.base_form}</div>`}
                    ${w.context_meaning && w.context_meaning !== w.meaning && html `<div class="pg-flash-ctx">${w.context_meaning}</div>`}
                    ${flipped && exampleView(w)}
                    ${w.notes && html `<div class="pg-flash-notes">${w.notes}</div>`}
                </div>
            </div>
            <div class="pg-pronun-result"></div>
            <div class="pg-flash-hint">${!flipped && t(srs ? 'fl.clickReveal' : 'fl.tapReveal')}</div>
            ${srs && flipped && ratingRow(days)}
            ${!srs && html `
            <div class="pg-flash-nav">
                <button class="pg-btn pg-btn-secondary" data-action="prev" ${this.index === 0 && html `disabled`}>${t('fl.prev')}</button>
                <button class="pg-btn pg-btn-primary" data-action="flip">${t(flipped ? 'fl.showWord' : 'fl.showMeaning')}</button>
                <button class="pg-btn pg-btn-secondary" data-action="next" ${this.index === this.deck.length - 1 && html `disabled`}>${t('fl.next')}</button>
            </div>`}`;
    }
    /** A cloze or typing card: the question on the front, the word and its meaning on the back. */
    askView(w, kind, progress, days) {
        const { flipped, typed } = this;
        const cloze = kind === 'cloze' ? clozeOf(w) : null;
        const result = typed && html `
            <div class="pg-flash-typed pg-flash-typed-${typed.grade}">
                ${typed.grade === 'correct' ? '✓' : html `✗ <s>${typed.text}</s>`}
                ${typed.grade === 'close' && html `<span class="pg-typed-close">${t('qz.typedClose')}</span>`}
            </div>`;
        return html `
            <div class="pg-flash-progress">${isMissed(w) && html `<span class="pg-srs-new pg-missed-tag">${t('wb.missedTag')}</span> `}${progress}</div>
            <div class="pg-flash-card pg-flash-ask ${flipped && 'pg-flash-flipped'}" data-action="flip">
                <div class="pg-flash-front">
                    ${cloze
            ? html `<div class="pg-flash-cloze">${sentenceView(cloze, true)}</div>
                               ${w.example_translation && html `<div class="pg-flash-example-trans">${w.example_translation}</div>`}`
            : html `<div class="pg-flash-meaning">${w.meaning}</div>
                               ${w.pos_info && html `<div class="pg-flash-pos">${w.pos_info}</div>`}`}
                </div>
                <div class="pg-flash-back">
                    ${flipped && w.image && html `<img class="pg-word-img" src="${userFileUrl(w.image)}" alt="">`}
                    <div class="pg-flash-word">${rubyWord(w.word, shownReading(w))}</div>
                    ${result}
                    <div class="pg-flash-meaning">${w.meaning}</div>
                    ${w.base_form && w.base_form !== w.word && html `<div class="pg-flash-pos">${w.base_form}</div>`}
                    ${flipped && exampleView(w)}
                    ${w.notes && html `<div class="pg-flash-notes">${w.notes}</div>`}
                    <div class="pg-flash-btn-row">
                        ${speakButton({ saved: !!w.audio, label: t('fl.listen'), cls: 'pg-flash-speak', action: 'speak' })}
                        ${this.deps.hasSpeechRecog() && html `<button class="pg-flash-mic" data-action="mic" title="${t('fl.mic')}" data-active="false">🎤</button>`}
                    </div>
                </div>
            </div>
            ${kind === 'typing' && !flipped && html `
            <form class="pg-flash-type">
                <input class="pg-soft-input pg-flash-input" type="text" autocomplete="off" spellcheck="false"
                    autocapitalize="off" enterkeyhint="done" placeholder="${t('fl.typeHere')}" aria-label="${t('fl.typeHere')}">
                <button type="submit" class="pg-btn pg-btn-primary">${t('speak.check')}</button>
            </form>`}
            <div class="pg-pronun-result"></div>
            <div class="pg-flash-hint">${!flipped && t(kind === 'cloze' ? 'fl.clozeHint' : 'fl.typeHint')}</div>
            ${flipped && ratingRow(days)}`;
    }
    render() {
        exampleRequest?.abort();
        const w = this.card;
        setHtml(this.area, w ? this.cardView(w) : this.emptyView());
        if (w && this.flipped && !w.example)
            loadExample(w, this.area, this.deps);
        this.area.querySelector('.pg-flash-input')?.focus({ preventScroll: true });
    }
    /** Grades the typed answer and turns the card over. */
    check() {
        const w = this.card;
        const input = this.area.querySelector('.pg-flash-input');
        const text = input?.value.trim();
        if (!w || !text)
            return;
        this.typed = { text, grade: gradeWord(w, text) };
        this.flipped = true;
        this.render();
    }
    // ── Actions ───────────────────────────────────────────────────────────────
    stopMic() {
        this.deps.getActiveRecog()?.abort();
        this.deps.setActiveRecog(null);
    }
    go(step) {
        const next = this.index + step;
        if (next < 0 || next >= this.deck.length)
            return;
        this.index = next;
        this.flipped = false;
        this.typed = null;
        this.render();
    }
    rate(rating) {
        const w = this.card;
        if (!w)
            return;
        const wordbook = loadWordbook();
        const entry = wordbook.find(e => e.word === w.word);
        if (!entry)
            return;
        const { requeue, wasNew } = srsRate(entry, rating);
        // A rating is one of many in a row: saved every few seconds, not on every card
        saveWordbook(wordbook, true);
        logReview({ wasNew, forgot: rating === 0 }, true);
        this.deck.splice(this.index, 1);
        if (requeue)
            this.deck.push(entry);
        else
            this.reviewed++;
        this.index = Math.min(this.index, Math.max(0, this.deck.length - 1));
        this.flipped = false;
        this.typed = null;
        this.updateControls();
        this.render();
    }
    /** "I know this word": marked known, so it leaves the review (not counted as reviewed). */
    setKnown() {
        const w = this.card;
        if (!w)
            return;
        setKnown([w.word], true);
        this.deck = this.deck.filter(e => e.word !== w.word);
        this.index = Math.min(this.index, Math.max(0, this.deck.length - 1));
        this.flipped = false;
        this.typed = null;
        this.updateControls();
        this.render();
    }
    onClick(e) {
        const el = e.target.closest('[data-action]');
        if (!el || !this.root.contains(el))
            return;
        const action = el.dataset.action;
        if (action !== 'mic')
            this.stopMic();
        const w = this.card;
        switch (action) {
            case 'flip':
                this.flipped = !this.flipped;
                this.render();
                break;
            case 'prev':
                e.stopPropagation();
                this.go(-1);
                break;
            case 'next':
                e.stopPropagation();
                this.go(1);
                break;
            case 'rate':
                this.rate(Number(el.dataset.rating));
                break;
            case 'set-known':
                this.setKnown();
                break;
            case 'toggle-srs':
                this.srs = !this.srs;
                this.restart();
                break;
            case 'browse-all':
                this.srs = false;
                this.restart();
                break;
            case 'more-new':
                this.extraNew += MORE_NEW;
                this.restart();
                break;
            case 'shuffle':
                if (this.srs)
                    break;
                this.restart();
                this.deck = shuffleArray(this.deck);
                this.render();
                break;
            case 'speak':
                e.stopPropagation();
                if (w)
                    this.deps.speak(w.word, this.deps.getLang(), { audio: w.audio, keep: { word: w.word, field: 'audio' } });
                break;
            case 'speak-example':
                e.stopPropagation();
                if (w?.example)
                    this.deps.speak(w.example, this.deps.getLang(), { audio: w.example_audio, keep: { word: w.word, field: 'example_audio' } });
                break;
            case 'mic': {
                e.stopPropagation();
                if (el.dataset.active === 'true') {
                    this.stopMic();
                    break;
                }
                const result = this.area.querySelector('.pg-pronun-result');
                if (w && result)
                    this.deps.setActiveRecog(this.deps.runPronunCheck(w.word, el, result));
                break;
            }
        }
    }
}
/** Renders the flashcard tab (set picker, SRS toggle, shuffle, card) into `container`; `review` starts in today's review. */
export function renderFlashcard(container, deps, review = false) {
    new FlashcardSession(container, deps, review);
}
