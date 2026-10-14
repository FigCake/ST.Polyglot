// Multiple-choice quizzes. Every variant is: generate questions → renderQuiz().
//
//   Quick / Full    from recent chat history
//   Cloze           prepositions, verb forms, idioms at the learner's level
//   Reading exam    10 grammar/vocab + 15 reading-comprehension questions
//   Verb drill      from a cached conjugation table
//   Weak points     new questions modelled on saved wrong answers
//
// renderQuiz() owns the answer flow: once every card is answered it shows the
// score, a "retry wrong" button (which re-renders those questions with
// shuffled options) and a "save to wrong list" button on each missed card.
//
// Design rules:
//   • No direct ST state reads — everything comes through QuizDeps.
//   • Generated questions always pass through sanitizeQuestions(), so every
//     card is answerable and its correct option is marked at render time.
//   • Each container runs one session at a time: starting a quiz cancels the
//     previous one's request and listeners in that container.
import { UI, QUIZ_TYPE_LABELS } from '../constants.js';
import { quizPrompt, clozeQuizPrompt, readingExamPrompt, conjDrillPrompt, targetedExamPrompt } from '../prompts.js';
import { shuffleArray } from '../utils.js';
import { html, setHtml } from '../html.js';
import { t } from '../i18n.js';
import { scoreView } from './quiz-score.js';
import { sanitizeQuestions } from './quiz-sanitize.js';
import { acceptList, unionBy } from '../ai/client.js';
import { cleanRawMessage } from '../study-scope.js';
import { ENOUGH_WORDS } from '../quiz-material.js';
/** The missed questions' words go back into today's reviews. */
export function relearnMissed(deps, words) {
    const missed = words.filter((w) => !!w);
    if (missed.length)
        deps.material?.relearn(missed);
}
/** A line over a quiz made at the learner's level because the wordbook had too little for it. */
export const generalNote = (level) => html `<div class="pg-quiz-note">${t('qz.generalNote', { level })}</div>`;
const TARGETED_SAMPLE = 5;
/** Combines two cut-off question lists, dropping repeats. */
const sameQuestion = unionBy(q => q.question.trim().toLowerCase());
// ── Sessions ──────────────────────────────────────────────────────────────────
const sessions = new WeakMap();
/** Cancels the container's previous quiz (request + listeners) and starts a new one. */
/** Starts a quiz in `container`, ending the one running there (any quiz variant). */
export function startSession(container) {
    sessions.get(container)?.abort();
    const session = new AbortController();
    sessions.set(container, session);
    return session.signal;
}
// ── Rendering ─────────────────────────────────────────────────────────────────
const skeleton = (cards = 4) => html `${Array.from({ length: cards }, () => html `
    <div class="pg-skeleton-quiz pg-skeleton">
        <div class="pg-skeleton-line pg-skeleton"></div>
        <div class="pg-skeleton-q pg-skeleton"></div>
        <div class="pg-skeleton-opt pg-skeleton"></div>
        <div class="pg-skeleton-opt pg-skeleton"></div>
        <div class="pg-skeleton-opt pg-skeleton"></div>
        <div class="pg-skeleton-opt pg-skeleton"></div>
    </div>`)}`;
const message = (kind, text) => html `<div class="${kind === 'error' ? 'pg-error-msg' : 'pg-empty-hint'}">${text}</div>`;
function card(q, i, showPassage) {
    const label = QUIZ_TYPE_LABELS[q.type] ?? q.type;
    return html `
        <div class="pg-quiz-card" data-idx="${i}">
            ${showPassage && html `<div class="pg-quiz-passage">${q.passage}</div>`}
            <div class="pg-quiz-type-badge">${label}</div>
            <div class="pg-quiz-q">Q${i + 1}. ${q.question}</div>
            <div class="pg-quiz-options">${q.options.map(opt => html `
                <button class="pg-opt-btn" ${opt === q.answer && html `data-correct`}>${opt}</button>`)}
            </div>
            <div class="pg-quiz-exp" hidden>
                <span class="pg-quiz-correct-label">Answer: ${q.answer}</span><br>
                ${q.explanation}
            </div>
        </div>`;
}
/** Cards for a question list; a reading passage is shown once, above its first question. */
function cards(questions) {
    return html `${questions.map((q, i) => card(q, i, !!q.passage && q.passage !== questions[i - 1]?.passage))}`;
}
function saveWrongAnswer(q, deps) {
    const saved = deps.wrongAnswers();
    if (saved.some(w => w.question === q.question))
        return;
    deps.saveWrongAnswers([...saved, {
            type: q.type, question: q.question, options: q.options,
            answer: q.answer, explanation: q.explanation, savedAt: Date.now(),
        }]);
}
function showScore(view, questions, wrong) {
    const scoreEl = view.container.querySelector('.pg-quiz-score');
    if (!scoreEl)
        return;
    scoreEl.hidden = false;
    setHtml(scoreEl, scoreView(questions.length, wrong.length));
    relearnMissed(view.deps, wrong.map(i => questions[i].word));
    scoreEl.querySelector('.pg-quiz-retry')?.addEventListener('click', () => {
        renderQuiz(view, wrong.map(i => ({ ...questions[i], options: shuffleArray(questions[i].options) })), true);
    });
    for (const i of wrong) {
        const exp = view.container.querySelector(`.pg-quiz-card[data-idx="${i}"] .pg-quiz-exp`);
        if (!exp)
            continue;
        const btn = Object.assign(document.createElement('button'), {
            className: 'pg-btn pg-btn-secondary pg-quiz-save-btn',
            textContent: t('qz.saveWrong'),
        });
        btn.addEventListener('click', () => {
            saveWrongAnswer(questions[i], view.deps);
            btn.textContent = t('qz.wrongSaved');
            btn.disabled = true;
        });
        exp.after(btn);
    }
}
/** Renders a question list and runs the answer flow until every card is answered. */
function renderQuiz(view, questions, isRetry = false) {
    const { container, signal } = view;
    setHtml(container, html `
        ${view.header}
        ${isRetry && html `<div class="pg-quiz-retry-header">${t('qz.retryHeader')}</div>`}
        ${cards(questions)}
        <div class="pg-quiz-score" hidden></div>`);
    // Ends on completion (a retry renders a fresh quiz) or when the session is replaced
    const answers = new AbortController();
    signal.addEventListener('abort', () => answers.abort(), { once: true });
    const wrong = [];
    let answered = 0;
    container.addEventListener('click', e => {
        const btn = e.target.closest('.pg-opt-btn');
        const card = btn?.closest('.pg-quiz-card');
        if (!btn || !card || card.classList.contains('pg-answered'))
            return;
        const ok = 'correct' in btn.dataset;
        card.classList.add('pg-answered');
        btn.classList.add(ok ? 'pg-opt-correct' : 'pg-opt-wrong');
        card.querySelector('.pg-quiz-exp')?.removeAttribute('hidden');
        if (!ok)
            wrong.push(Number(card.dataset.idx));
        view.deps.logStudy?.();
        if (++answered === questions.length) {
            answers.abort();
            showScore(view, questions, wrong.sort((a, b) => a - b));
        }
    }, { signal: answers.signal });
}
/** Generates questions and renders them; shows a message on failure. */
async function generate(container, deps, opts, signal = startSession(container)) {
    setHtml(container, html `${opts.header}${skeleton(opts.skeleton)}`);
    try {
        const { data } = await deps.ai.json({
            prompt: opts.prompt,
            signal,
            accept: acceptList('questions', sanitizeQuestions),
            merge: sameQuestion,
        });
        if (signal.aborted)
            return;
        renderQuiz({ container, deps, signal, header: opts.header }, data);
    }
    catch (e) {
        if (signal.aborted)
            return;
        setHtml(container, message('error', t('qz.genFail', { msg: e instanceof Error ? e.message : String(e) })));
    }
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Quiz on the recent chat.
 * @param historyCount  recent messages used (3 → quick, 6 → full)
 * @param questionCount questions generated (5 → quick, 20 → full)
 */
export async function runMiniQuiz(container, deps, historyCount = UI.quizHistoryMessages, questionCount = 5) {
    const signal = startSession(container);
    // Status windows and other skipped parts are not part of the conversation
    const messages = (deps.getContext().chat ?? [])
        .map(m => ({ name: m.name, mes: cleanRawMessage(m.mes ?? '', deps.getSettings()) }))
        .filter(m => m.mes);
    if (messages.length < 2) {
        setHtml(container, message('empty', t('qz.noMessages')));
        return;
    }
    const history = messages.slice(-historyCount).map(m => `${m.name}: ${m.mes}`).join('\n');
    const { cefr_level } = deps.getSettings();
    return generate(container, deps, {
        prompt: quizPrompt(history, deps.getLang(), cefr_level, deps.getNativeLang(), questionCount),
    }, signal);
}
/**
 * Fill-in-the-blank questions on 10–20 random words being studied; with too
 * few in the wordbook, 20 general ones at the learner's level.
 */
export function runClozeQuiz(container, deps) {
    const level = deps.getSettings().cefr_level;
    const words = deps.material?.words() ?? [];
    const enough = words.length >= ENOUGH_WORDS;
    return generate(container, deps, {
        prompt: clozeQuizPrompt(deps.getLang(), level, deps.getNativeLang(), enough ? words : []),
        header: enough ? undefined : generalNote(level),
    });
}
/** Half mock exam: 10 grammar/vocab + 15 reading questions at the learner's level. */
export function runReadingExam(container, deps) {
    const { cefr_level } = deps.getSettings();
    return generate(container, deps, {
        prompt: readingExamPrompt(deps.getLang(), cefr_level, deps.getNativeLang()),
        skeleton: 6,
        header: html `
            <div class="pg-exam-header">
                <span class="pg-exam-title">${t('qz.examTitle')}</span>
                <span class="pg-exam-level">${cefr_level}</span>
            </div>`,
    });
}
/**
 * Verb forms of a few random verbs being studied (with the conjugation tables
 * opened for them); without any, of common verbs at the learner's level.
 */
export async function runConjDrill(container, deps) {
    const signal = startSession(container);
    const lang = deps.getLang();
    const level = deps.getSettings().cefr_level;
    setHtml(container, skeleton(3));
    const verbs = deps.material?.verbs() ?? [];
    const tables = verbs.length ? await deps.getAllConjCache(lang).catch(() => []) : [];
    if (signal.aborted)
        return;
    const key = (w) => w.normalize('NFKC').toLowerCase().trim();
    const byWord = new Map(tables.map(e => [key(e.word), e.data]));
    const drill = verbs.map(v => ({ word: v.word, table: byWord.get(key(v.word)) }));
    return generate(container, deps, {
        prompt: conjDrillPrompt(drill, lang, level, deps.getNativeLang()),
        skeleton: 3,
        header: drill.length
            ? html `<div class="pg-quiz-drill-header">${drill.map(v => html `<span class="pg-quiz-drill-verb">${v.word}</span>`)}</div>`
            : generalNote(level),
    }, signal);
}
/** New questions modelled on up to five random saved wrong answers. */
export function runTargetedExam(container, deps) {
    const signal = startSession(container);
    const saved = deps.wrongAnswers();
    if (!saved.length) {
        setHtml(container, message('error', t('qz.noWrong')));
        return Promise.resolve();
    }
    // Delegated, so the button keeps working when the header is re-rendered (retry)
    container.addEventListener('click', async (e) => {
        if (!e.target.closest('.pg-targeted-clear'))
            return;
        if (!(await deps.askConfirm(t('qz.clearWrong') + '?')))
            return;
        deps.saveWrongAnswers([]);
        startSession(container);
        setHtml(container, message('error', t('qz.noWrong')));
    }, { signal });
    const sample = shuffleArray(saved).slice(0, TARGETED_SAMPLE);
    return generate(container, deps, {
        prompt: targetedExamPrompt(sample, deps.getLang(), deps.getNativeLang()),
        header: html `
            <div class="pg-quiz-targeted-header">
                <span>${t('qz.wrongCount', { n: saved.length })}</span>
                <button class="pg-btn pg-btn-secondary pg-btn-compact pg-targeted-clear">${t('qz.clearWrong')}</button>
            </div>`,
    }, signal);
}
