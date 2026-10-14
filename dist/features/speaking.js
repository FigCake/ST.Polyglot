// Listening / speaking drill over the wordbook, one card at a time:
//
//   Dictation  hear the word, type it → similarity score
//   Shadowing  hear the word, say it  → speech-recognition match score
//   Random     either, per card (dictation when speech recognition is unavailable)
//
// Over words, or over saved sentences (lines of dialogue saved from the chat,
// sentences saved from a translation): hear it, then say it after the voice.
//
// Design rules:
//   • speak / runPronunciationCheck are injected via SpeakingDeps.
//   • Card pool = the current wordbook scope's words (not grammar patterns), or its sentences.
import { shuffleArray, similarityScore } from '../utils.js';
import { html, setHtml } from '../html.js';
import { scopedWordbook } from '../wordbook.js';
import { isCard } from '../srs.js';
import { t } from '../i18n.js';
const SOURCES = [
    { source: 'words', key: 'speak.srcWords' },
    { source: 'sentences', key: 'speak.srcSentences' },
];
const MODE_CHOICES = [
    { mode: 'random', key: 'speak.modeRandom' },
    { mode: 'dictation', key: 'speak.modeDictation' },
    { mode: 'shadowing', key: 'speak.modeShadowing' },
];
// ── Scoring ───────────────────────────────────────────────────────────────────
/** Re-exported under its historical name (used by speaking.test.ts). */
export { levenshtein as _levenshtein } from '../utils.js';
/** Anything but letters, combining marks (accents, Thai and Indic vowel signs) and digits, in every script. */
const NOT_TEXT = /[^\p{L}\p{M}\p{N} ]/gu;
const comparable = (s) => s.normalize('NFC').toLowerCase().trim().replace(NOT_TEXT, '');
/** Similarity (0–100) of a typed answer to the target, ignoring case and punctuation. */
export function _dictationScore(target, input) {
    const a = comparable(target), b = comparable(input);
    if (!a)
        return 100;
    if (!b)
        return 0;
    return similarityScore(a, b);
}
const DICTATION_GRADES = [
    { min: 95, key: 'tts.perfect', cls: 'pg-pronun-perfect' },
    { min: 75, key: 'tts.great', cls: 'pg-pronun-great' },
    { min: 50, key: 'tts.keep', cls: 'pg-pronun-ok' },
    { min: 0, key: 'tts.tryAgain', cls: 'pg-pronun-tryagain' },
];
const gradeOf = (score) => DICTATION_GRADES.find(g => score >= g.min) ?? DICTATION_GRADES[DICTATION_GRADES.length - 1];
// ── Views ─────────────────────────────────────────────────────────────────────
const revealView = (w) => html `
    <span class="pg-speak-answer">${w.word}</span>
    ${w.meaning && html `<span class="pg-speak-meaning">${w.meaning}</span>`}`;
function cardView(mode) {
    const isDictation = mode === 'dictation';
    return html `
        <div class="pg-speak-card">
            <div class="pg-speak-card-badge">${t(isDictation ? 'speak.modeDictation' : 'speak.modeShadowing')}</div>
            <button class="pg-speak-play-btn" data-action="play" title="${t('speak.play')}" aria-label="${t('speak.play')}">🔊</button>
            <div class="pg-speak-hint">${t(isDictation ? 'speak.dictHint' : 'speak.shadHint')}</div>
            ${isDictation ? html `
            <textarea class="pg-speak-textarea text_pole" placeholder="${t('speak.dictPh')}" rows="2"
                      autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
            <button class="pg-btn pg-btn-primary pg-btn-full" data-action="check">${t('speak.check')}</button>
            <div class="pg-pronun-result"></div>` : html `
            <div class="pg-speak-mic-row">
                <button class="pg-speak-mic-btn" data-action="mic" title="${t('speak.mic')}" aria-label="${t('speak.mic')}">🎤</button>
                <div class="pg-pronun-result"></div>
            </div>`}
            <div class="pg-speak-reveal" hidden></div>
            <button class="pg-btn pg-btn-secondary pg-btn-full pg-speak-next" data-action="next" hidden>${t('speak.next')}</button>
        </div>`;
}
// ── Session ───────────────────────────────────────────────────────────────────
class SpeakingSession {
    root;
    sources;
    deps;
    pool = [];
    index = 0;
    choice = 'random';
    source;
    recognition = null;
    area;
    constructor(root, sources, deps, initial) {
        this.root = root;
        this.sources = sources;
        this.deps = deps;
        this.source = initial && sources[initial].length ? initial : sources.words.length ? 'words' : 'sentences';
        setHtml(root, html `
            ${sources.sentences.length > 0 && html `
            <div class="pg-speak-mode-group pg-speak-source" role="group">${SOURCES.map(c => html `
                <button class="pg-speak-mode-btn ${c.source === this.source && 'active'}" data-action="source" data-source="${c.source}" ${!sources[c.source].length && html `disabled`}>${t(c.key)} ${sources[c.source].length}</button>`)}
            </div>`}
            <div class="pg-speak-controls">
                <div class="pg-speak-mode-group" role="group">${MODE_CHOICES.map(c => html `
                    <button class="pg-speak-mode-btn ${c.mode === this.choice && 'active'}" data-action="mode" data-mode="${c.mode}">${t(c.key)}</button>`)}
                </div>
                <span class="pg-speak-progress"></span>
            </div>
            <div class="pg-speak-card-area"></div>`);
        this.area = root.querySelector('.pg-speak-card-area');
        root.addEventListener('click', e => this.onClick(e));
        // Words acting as buttons (a missed word) are pressed with Enter or Space too
        root.addEventListener('keydown', e => {
            const el = e.target;
            if ((e.key === 'Enter' || e.key === ' ') && el.matches('[role="button"][data-action]')) {
                e.preventDefault();
                el.click();
            }
        });
        this.restart();
    }
    get entry() { return this.pool[this.index]; }
    restart() {
        this.pool = shuffleArray(this.sources[this.source]);
        this.index = 0;
        this.render();
    }
    modeFor() {
        const mode = this.choice === 'random' ? (Math.random() < 0.5 ? 'dictation' : 'shadowing') : this.choice;
        return mode === 'shadowing' && !this.deps.hasSpeechRecognition() ? 'dictation' : mode;
    }
    render() {
        this.recognition?.abort();
        this.recognition = null;
        const progress = this.root.querySelector('.pg-speak-progress');
        if (progress)
            progress.textContent = `${Math.min(this.index + 1, this.pool.length)} / ${this.pool.length}`;
        const w = this.entry;
        if (!w) {
            setHtml(this.area, html `
                <div class="pg-score-perfect">${t('speak.done')}</div>
                <button class="pg-btn pg-btn-secondary pg-btn-full pg-speak-restart" data-action="restart">${t('speak.restart')}</button>`);
            return;
        }
        setHtml(this.area, cardView(this.modeFor()));
        this.deps.speak(w.word, this.deps.getLang(), { audio: w.audio, keep: { word: w.word, field: 'audio' }, speaker: w.speaker }); // play on open
    }
    /** Shows the answer and the Next button. */
    reveal() {
        const w = this.entry;
        const reveal = this.area.querySelector('.pg-speak-reveal');
        if (!w || !reveal)
            return;
        setHtml(reveal, revealView(w));
        reveal.hidden = false;
        const next = this.area.querySelector('.pg-speak-next');
        if (next)
            next.hidden = false;
    }
    check(button) {
        const w = this.entry;
        const input = this.area.querySelector('textarea')?.value.trim();
        const out = this.area.querySelector('.pg-pronun-result');
        if (!w || !input || !out)
            return;
        const score = _dictationScore(w.word, input);
        const grade = gradeOf(score);
        out.className = `pg-pronun-result ${grade.cls}`;
        out.textContent = `${score}% — ${t(grade.key)}`;
        button.hidden = true;
        this.deps.logStudy?.();
        this.reveal();
    }
    listen(mic) {
        if (mic.dataset.active === 'true') {
            this.recognition?.abort();
            return;
        }
        const out = this.area.querySelector('.pg-pronun-result');
        const w = this.entry;
        if (w && out)
            this.recognition = this.deps.runPronunciationCheck(w.word, mic, out, () => { this.deps.logStudy?.(); this.reveal(); });
    }
    onClick(e) {
        const el = e.target.closest('[data-action]');
        if (!el)
            return;
        switch (el.dataset.action) {
            case 'mode':
                this.root.querySelectorAll('[data-action="mode"]').forEach(b => b.classList.toggle('active', b === el));
                this.choice = el.dataset.mode;
                this.restart();
                break;
            case 'source':
                this.root.querySelectorAll('[data-action="source"]').forEach(b => b.classList.toggle('active', b === el));
                this.source = el.dataset.source;
                this.restart();
                break;
            case 'play':
                if (this.entry)
                    this.deps.speak(this.entry.word, this.deps.getLang(), { audio: this.entry.audio, keep: { word: this.entry.word, field: 'audio' }, speaker: this.entry.speaker });
                break;
            case 'check':
                this.check(el);
                break;
            // A word the recognition missed in a sentence, read alone
            case 'say-word':
                if (el.dataset.word)
                    this.deps.speak(el.dataset.word, this.deps.getLang());
                break;
            case 'mic':
                this.listen(el);
                break;
            case 'next':
                this.index++;
                this.render();
                break;
            case 'restart':
                this.restart();
                break;
        }
    }
}
/** Opens the drill; `initial` picks words or saved sentences first (when there are any). */
export function renderSpeaking(container, deps, initial) {
    const entries = scopedWordbook().filter(e => e.word?.trim());
    const sources = { words: entries.filter(isCard), sentences: entries.filter(e => e.level === 'sentence') };
    if (!sources.words.length && !sources.sentences.length) {
        setHtml(container, html `<div class="pg-error-msg">${t('speak.noEntries')}</div>`);
        return;
    }
    new SpeakingSession(container, sources, deps, initial);
}
