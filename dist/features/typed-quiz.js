// Typed grammar quiz (⌨️ in the quiz modes): one-gap sentences the learner
// completes by typing the form, like the grammar sections of language exams,
// at the learner's CEFR level. Answers are graded on the device.
//
//   generate (AI, once) ─▶ type + Enter (or the keyboard's Go / Done) per card,
//   or "Grade all" ─▶ correct / near miss / wrong ─▶ score, retry the wrong
//   ones, save them to the wrong-answer list
//
// Each gap is its own <form>, so the browser submits it on Enter or a phone
// keyboard's Go / Done key (whose keydown may carry no "Enter", or come mid-
// composition); a key handler alone missed those.
//
// Design rules:
//   • No direct ST state reads — everything comes through QuizDeps.
//   • Questions pass through acceptTypedQuestions(); grading is gradeTyped().
import { html, setHtml } from '../html.js';
import { t } from '../i18n.js';
import { scoreView } from './quiz-score.js';
import { typedGrammarPrompt } from '../prompts.js';
import { cleanRawMessage } from '../study-scope.js';
import { unionBy } from '../ai/client.js';
import { acceptTypedQuestions, gradeTyped, BLANK } from './writing-model.js';
import { startSession } from './quiz.js';
const COUNT = 10;
/** Recent chat used as a theme for the sentences (status windows left out). */
const CONTEXT_MESSAGES = 4;
const CONTEXT_MAX_CHARS = 2000;
function chatContext(deps) {
    const s = deps.getSettings();
    const text = (deps.getContext().chat ?? [])
        .map(m => cleanRawMessage(m.mes ?? '', s))
        .filter(Boolean)
        .slice(-CONTEXT_MESSAGES)
        .join('\n');
    return text.slice(-CONTEXT_MAX_CHARS);
}
const skeleton = () => html `${[0, 1, 2].map(() => html `
    <div class="pg-skeleton-quiz pg-skeleton">
        <div class="pg-skeleton-line pg-skeleton"></div>
        <div class="pg-skeleton-q pg-skeleton"></div>
    </div>`)}`;
function card(q, i) {
    const [before, after] = q.sentence.split(BLANK);
    return html `
        <div class="pg-quiz-card pg-typed-card" data-idx="${i}">
            ${q.point && html `<div class="pg-quiz-type-badge">${q.point}</div>`}
            <div class="pg-quiz-q">
                Q${i + 1}. ${before}<form class="pg-typed-form"><input class="pg-soft-input pg-typed-input" type="text" autocomplete="off"
                    spellcheck="false" autocapitalize="off" enterkeyhint="done" aria-label="${q.hint || t('qz.typedBlank')}"></form>${after}
                ${q.hint && html `<span class="pg-typed-hint">${q.hint}</span>`}
            </div>
            <div class="pg-quiz-exp" hidden>
                <span class="pg-quiz-correct-label">${t('qz.typedAnswer', { answer: q.answers.join(' / ') })}</span>
                <span class="pg-typed-close" hidden>${t('qz.typedClose')}</span><br>
                ${q.explanation}
            </div>
        </div>`;
}
function saveWrong(q, deps) {
    const saved = deps.wrongAnswers();
    const question = `${q.sentence} ${q.hint}`.trim();
    if (saved.some(w => w.question === question))
        return;
    deps.saveWrongAnswers([...saved, {
            type: 'grammar', question, options: [], answer: q.answers[0], explanation: q.explanation, savedAt: Date.now(),
        }]);
}
function render(container, deps, questions, signal, isRetry = false) {
    setHtml(container, html `
        ${isRetry && html `<div class="pg-quiz-retry-header">${t('qz.retryHeader')}</div>`}
        ${questions.map((q, i) => card(q, i))}
        <button class="pg-btn pg-btn-primary pg-btn-full pg-typed-grade-all">${t('qz.typedGradeAll')}</button>
        <div class="pg-quiz-score" hidden></div>`);
    const wrong = [];
    let answered = 0;
    /** Grades one gap; an empty one only when `blankToo` ("Grade all" counts it wrong and shows the answer). */
    const check = (input, blankToo = false) => {
        const cardEl = input.closest('.pg-typed-card');
        if (!cardEl || cardEl.classList.contains('pg-answered') || (!input.value.trim() && !blankToo))
            return;
        const i = Number(cardEl.dataset.idx);
        const grade = gradeTyped(input.value, questions[i].answers);
        cardEl.classList.add('pg-answered');
        input.readOnly = true;
        input.classList.add(grade === 'correct' ? 'pg-typed-ok' : 'pg-typed-bad');
        cardEl.querySelector('.pg-quiz-exp')?.removeAttribute('hidden');
        if (grade === 'close')
            cardEl.querySelector('.pg-typed-close')?.removeAttribute('hidden');
        if (grade !== 'correct')
            wrong.push(i);
        // On to the next unanswered card
        const next = [...container.querySelectorAll('.pg-typed-input')].find(x => !x.readOnly);
        if (!blankToo)
            next?.focus({ preventScroll: false });
        if (++answered === questions.length) {
            container.querySelector('.pg-typed-grade-all')?.remove();
            showScore(container, deps, questions, wrong.sort((a, b) => a - b), signal);
        }
    };
    container.addEventListener('submit', e => {
        const form = e.target;
        if (!form.matches?.('.pg-typed-form'))
            return;
        e.preventDefault();
        const input = form.querySelector('.pg-typed-input');
        if (input)
            check(input);
    }, { signal });
    container.querySelector('.pg-typed-grade-all')?.addEventListener('click', () => {
        for (const input of container.querySelectorAll('.pg-typed-input'))
            check(input, true);
    }, { signal });
    container.querySelector('.pg-typed-input')?.focus({ preventScroll: true });
}
function showScore(container, deps, questions, wrong, signal) {
    const scoreEl = container.querySelector('.pg-quiz-score');
    if (!scoreEl)
        return;
    scoreEl.hidden = false;
    setHtml(scoreEl, scoreView(questions.length, wrong.length));
    scoreEl.querySelector('.pg-quiz-retry')?.addEventListener('click', () => {
        render(container, deps, wrong.map(i => questions[i]), startSession(container), true);
    });
    for (const i of wrong) {
        const exp = container.querySelector(`.pg-typed-card[data-idx="${i}"] .pg-quiz-exp`);
        if (!exp)
            continue;
        const btn = Object.assign(document.createElement('button'), {
            className: 'pg-btn pg-btn-secondary pg-quiz-save-btn', textContent: t('qz.saveWrong'),
        });
        btn.addEventListener('click', () => {
            saveWrong(questions[i], deps);
            btn.textContent = t('qz.wrongSaved');
            btn.disabled = true;
        }, { signal });
        exp.after(btn);
    }
}
/** Ten typed grammar questions at the learner's level, themed on the recent chat when there is one. */
export async function runTypedGrammar(container, deps) {
    const signal = startSession(container);
    setHtml(container, skeleton());
    try {
        const { data } = await deps.ai.json({
            prompt: typedGrammarPrompt(deps.getLang(), deps.getSettings().cefr_level, deps.getNativeLang(), COUNT, chatContext(deps)),
            signal,
            accept: acceptTypedQuestions,
            merge: unionBy(q => q.sentence),
        });
        if (signal.aborted)
            return;
        render(container, deps, data, signal);
    }
    catch (e) {
        if (signal.aborted)
            return;
        setHtml(container, html `<div class="pg-error-msg">${t('qz.genFail', { msg: e instanceof Error ? e.message : String(e) })}</div>`);
    }
}
