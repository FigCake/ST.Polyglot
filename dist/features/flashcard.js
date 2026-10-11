// Flashcards: browse mode, or review mode (FSRS, srs.ts): today's due words
// first, then new words up to the day's limit (setting srs_new_per_day).
//
//   front  word · part of speech · 🔊 · 🎤 pronunciation check
//   back   meaning · base form · meaning in context · example sentence · note
//
// Example sentences are generated once, on the first flip of a card without
// one, and saved to the entry.
//
// Design rules:
//   • ST state and runtime helpers come in through FlashDeps.
//   • One delegated click handler per session; re-rendering a card never re-binds.
import { exampleSentencePrompt } from '../prompts.js';
import { shuffleArray } from '../utils.js';
import { rubyWord, shownReading } from '../furigana/word.js';
import { html, setHtml, raw } from '../html.js';
import { t, currentLang } from '../i18n.js';
import { loadWordbook, saveWordbook, scopedWordbook, getSets } from '../wordbook.js';
import { srsRate, previewDays, todaysCards, forecast, isNew, isMissed } from '../srs.js';
import { logReview, newWordsToday } from '../study-log.js';
import { acceptObject } from '../ai/client.js';
import { userFileUrl } from '../user-files.js';
const RATINGS = [
    { rating: 0, key: 'fl.again', cls: 'pg-srs-again' },
    { rating: 1, key: 'fl.hard', cls: 'pg-srs-hard' },
    { rating: 2, key: 'fl.good', cls: 'pg-srs-good' },
    { rating: 3, key: 'fl.easy', cls: 'pg-srs-easy' },
];
/** Grammar patterns and sentences are review material for quizzes, not cards. */
export const isCard = (w) => w.level !== 'grammar' && w.level !== 'sentence';
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
const multiline = (text) => html `${text.split('\n').map((line, i) => html `${i > 0 && raw('<br>')}${line}`)}`;
// ── Example sentences ─────────────────────────────────────────────────────────
let exampleRequest = null;
function exampleView(w) {
    if (!w.example)
        return html `
        <div class="pg-flash-example-wrap">
            <div class="pg-flash-example pg-flash-example-loading"><i class="fa-solid fa-spinner fa-spin"></i></div>
        </div>`;
    return html `
        <div class="pg-flash-example-wrap">
            <div class="pg-flash-example">${w.example}</div>
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
        });
        const sentence = data.sentence?.trim();
        if (request.signal.aborted || !sentence)
            return;
        // Re-read so concurrent SRS updates are not overwritten
        const wordbook = loadWordbook();
        const entry = wordbook.find(e => e.word === w.word);
        const translation = data.translation?.trim() || undefined;
        if (entry) {
            Object.assign(entry, { example: sentence, example_translation: translation ?? entry.example_translation });
            saveWordbook(wordbook);
        }
        Object.assign(w, { example: sentence, example_translation: translation });
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
        this.setSelect.addEventListener('change', () => this.restart());
        this.restart();
    }
    get card() { return this.deck[this.index]; }
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
        const more = pool.some(isNew);
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
        return html `
            <div class="pg-flash-progress">${srs && isNew(w) && html `<span class="pg-srs-new">${t('fl.newBadge')}</span> `}${isMissed(w) && html `<span class="pg-srs-new pg-missed-tag">${t('wb.missedTag')}</span> `}${progress}</div>
            <div class="pg-flash-card ${flipped && 'pg-flash-flipped'}" data-action="flip">
                <div class="pg-flash-front">
                    <div class="pg-flash-word">${rubyWord(w.word, shownReading(w))}</div>
                    ${w.pos_info && html `<div class="pg-flash-pos">${w.pos_info}</div>`}
                    <div class="pg-flash-btn-row">
                        <button class="pg-speak-btn pg-flash-speak" data-action="speak" title="${t('fl.listen')}">🔊</button>
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
            ${srs && flipped && html `
            <div class="pg-srs-rating">${RATINGS.map(r => html `
                <button class="pg-srs-btn ${r.cls}" data-action="rate" data-rating="${r.rating}">
                    <span class="pg-srs-label">${t(r.key)}</span>
                    <span class="pg-srs-preview">${r.rating === 0 ? t('fl.ivlSoon') : intervalLabel(days[r.rating])}</span>
                </button>`)}
            </div>`}
            ${!srs && html `
            <div class="pg-flash-nav">
                <button class="pg-btn pg-btn-secondary" data-action="prev" ${this.index === 0 && html `disabled`}>${t('fl.prev')}</button>
                <button class="pg-btn pg-btn-primary" data-action="flip">${t(flipped ? 'fl.showWord' : 'fl.showMeaning')}</button>
                <button class="pg-btn pg-btn-secondary" data-action="next" ${this.index === this.deck.length - 1 && html `disabled`}>${t('fl.next')}</button>
            </div>`}`;
    }
    render() {
        exampleRequest?.abort();
        const w = this.card;
        setHtml(this.area, w ? this.cardView(w) : this.emptyView());
        if (w && this.flipped && !w.example)
            loadExample(w, this.area, this.deps);
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
        saveWordbook(wordbook);
        logReview({ wasNew, forgot: rating === 0 });
        this.deck.splice(this.index, 1);
        if (requeue)
            this.deck.push(entry);
        else
            this.reviewed++;
        this.index = Math.min(this.index, Math.max(0, this.deck.length - 1));
        this.flipped = false;
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
                    this.deps.speak(w.word, this.deps.getLang(), w.audio);
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
