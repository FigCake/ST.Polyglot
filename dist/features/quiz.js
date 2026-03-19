// ════════════════════════════
// Polyglot  features/quiz.ts
// ════════════════════════════
// Mini-quiz feature: generates 5 multiple-choice questions from recent chat
// history and handles answer interaction + retry flow.
//
// Design rules:
//   • No direct ST state reads — caller injects chat history, lang, level.
//   • callModel and parseJSON are injected via the deps object to keep this
//     module testable without mocking ST internals.
//   • DOM manipulation is scoped to the container element passed by the caller.
//
// Dependencies: types.ts, constants.ts, utils.ts, prompts.ts, ui.manager.ts
import { UI, API, QUIZ_TYPE_LABELS } from '../constants.js';
import { quizPrompt, clozeQuizPrompt, readingExamPrompt, conjDrillPrompt, targetedExamPrompt } from '../prompts.js';
import { parseJSON, shuffleArray } from '../utils.js';
import { escapeHtml } from '../ui.manager.js';
import { t } from '../i18n.js';
// ── Module-level abort tracker ────────────────────────────────────────────────
let _quizAbort = null;
// ── Internal helpers ──────────────────────────────────────────────────────────
// ── Skeleton loading helpers ───────────────────────────────────────────────
/** Returns skeleton HTML for N quiz card placeholders. */
function _skeletonQuiz(n = 4) {
    const card = `
        <div class="pg-skeleton-quiz pg-skeleton">
            <div class="pg-skeleton-line pg-skeleton" style="width:75%;"></div>
            <div class="pg-skeleton-q pg-skeleton"></div>
            <div class="pg-skeleton-opt pg-skeleton"></div>
            <div class="pg-skeleton-opt pg-skeleton" style="width:92%;"></div>
            <div class="pg-skeleton-opt pg-skeleton" style="width:86%;"></div>
            <div class="pg-skeleton-opt pg-skeleton" style="width:78%;"></div>
        </div>`;
    return Array(n).fill(card).join('');
}
function _renderQuizCards(questions) {
    // Track the last passage rendered to avoid repeating the same block
    let lastPassage = '';
    return questions.map((q, i) => {
        const label = QUIZ_TYPE_LABELS[q.type] || q.type;
        // Show the passage only once — at the first question that introduces it
        const passageHtml = (q.passage && q.passage !== lastPassage)
            ? `<div class="pg-quiz-passage">${escapeHtml(q.passage)}</div>`
            : '';
        if (q.passage)
            lastPassage = q.passage;
        return `
            <div class="pg-quiz-card" data-idx="${i}">
                ${passageHtml}
                <div class="pg-quiz-type-badge">${label}</div>
                <div class="pg-quiz-q">Q${i + 1}. ${escapeHtml(q.question)}</div>
                <div class="pg-quiz-options">
                    ${(q.options ?? []).map(opt => `<button class="pg-opt-btn" data-ans="${escapeHtml(q.answer)}">${escapeHtml(opt)}</button>`).join('')}
                </div>
                <div class="pg-quiz-exp" style="display:none;">
                    <span class="pg-quiz-correct-label">Answer: ${escapeHtml(q.answer)}</span><br>
                    ${escapeHtml(q.explanation)}
                </div>
            </div>`;
    }).join('');
}
function _bindQuizAnswers(container, questions, onComplete) {
    const total = questions.length;
    let answered = 0, correct = 0;
    const wrongIdxs = [];
    container.querySelectorAll('.pg-opt-btn').forEach(btn => {
        btn.onclick = e => {
            const btn_ = e.target;
            const card = btn_.closest('.pg-quiz-card');
            if (!card || card.classList.contains('pg-answered'))
                return;
            card.classList.add('pg-answered');
            const ok = (btn_.textContent ?? '').trim() === (btn_.dataset.ans ?? '').trim();
            btn_.classList.add(ok ? 'pg-opt-correct' : 'pg-opt-wrong');
            card.querySelector('.pg-quiz-exp').style.display = 'block';
            if (ok)
                correct++;
            else
                wrongIdxs.push(parseInt(card.dataset.idx ?? '0'));
            answered++;
            if (answered === total)
                onComplete?.(correct, wrongIdxs);
        };
    });
}
function _showScore(container, correct, total, wrongIdxs, questions, deps) {
    const scoreEl = container.querySelector('#pg-quiz-score');
    if (!scoreEl)
        return;
    scoreEl.style.display = 'block';
    scoreEl.innerHTML = `
        <div class="pg-score-text">${correct} / ${total} correct</div>
        ${wrongIdxs.length > 0
        ? `<button id="pg-quiz-retry" class="pg-btn pg-btn-secondary pg-btn-full" style="margin-top:6px;">
                   ${t('qz.retry', { n: wrongIdxs.length })}
               </button>`
        : `<div class="pg-score-perfect">${t('qz.allCorrect')}</div>`}`;
    scoreEl.querySelector('#pg-quiz-retry')?.addEventListener('click', () => {
        retryWrongQuestions(container, questions, wrongIdxs, deps);
    });
    // Inject "save to wrong list" button into each wrong card
    if (deps && wrongIdxs.length > 0) {
        wrongIdxs.forEach(idx => {
            const card = container.querySelector(`.pg-quiz-card[data-idx="${idx}"]`);
            if (!card || card.querySelector('.pg-quiz-save-btn'))
                return;
            const btn = document.createElement('button');
            btn.className = 'pg-btn pg-btn-secondary pg-quiz-save-btn';
            btn.style.cssText = 'margin-top:6px;width:100%;font-size:0.8em;';
            btn.textContent = t('qz.saveWrong');
            btn.addEventListener('click', () => {
                const q = questions[idx];
                const s = deps.getSettings();
                if (!Array.isArray(s.saved_wrong_answers))
                    s.saved_wrong_answers = [];
                // Avoid exact duplicates
                const exists = s.saved_wrong_answers.some(w => w.question === q.question);
                if (!exists) {
                    s.saved_wrong_answers.push({
                        type: q.type,
                        question: q.question,
                        options: q.options,
                        answer: q.answer,
                        explanation: q.explanation,
                        savedAt: Date.now(),
                    });
                    deps.saveSettings();
                }
                btn.textContent = t('qz.wrongSaved');
                btn.disabled = true;
            });
            card.querySelector('.pg-quiz-exp')?.after(btn);
        });
    }
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Generates a chat-history-based quiz and renders it into the container.
 * @param historyCount  Recent messages to use (3 → quick quiz; 6 → full quiz)
 * @param questionCount Questions to generate (5 → quick quiz; 20 → full quiz)
 */
export async function runMiniQuiz(container, deps, historyCount = UI.quizHistoryMessages, questionCount = 5) {
    _quizAbort?.abort();
    const abort = new AbortController();
    _quizAbort = abort;
    container.innerHTML = _skeletonQuiz();
    try {
        const ctx = deps.getContext();
        const messages = (ctx.chat ?? []).filter(m => m.mes?.trim());
        if (messages.length < 2) {
            container.innerHTML = `<div class="pg-empty-hint">${t('qz.noMessages')}</div>`;
            return;
        }
        const history = messages
            .slice(-historyCount)
            .map(m => `${m.name}: ${m.mes}`)
            .join('\n');
        const s = deps.getSettings();
        const result = parseJSON(await deps.callModel(API.sysJson, quizPrompt(history, deps.getLang(), s.cefr_level, deps.getNativeLang(), questionCount), abort.signal));
        if (abort.signal.aborted)
            return;
        if (!Array.isArray(result?.questions) || result.questions.length === 0) {
            container.innerHTML = `<div class="pg-empty-hint">${t('qz.loadFail')}</div>`;
            return;
        }
        const questions = result.questions;
        container.innerHTML = _renderQuizCards(questions) +
            `<div id="pg-quiz-score" class="pg-quiz-score" style="display:none;"></div>`;
        _bindQuizAnswers(container, questions, (correct, wrongIdxs) => {
            _showScore(container, correct, questions.length, wrongIdxs, questions, deps);
        });
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        const msg = e instanceof Error ? e.message : String(e);
        container.innerHTML = `<div class="pg-error-msg">${t('qz.genFail', { msg: escapeHtml(msg) })}</div>`;
    }
    finally {
        if (_quizAbort === abort)
            _quizAbort = null;
    }
}
/**
 * Generates a 20-question cloze (fill-in-the-blank) quiz targeting
 * prepositions, verb conjugations, and idioms at the user's CEFR level.
 * Independent of chat history.
 */
export async function runClozeQuiz(container, deps) {
    _quizAbort?.abort();
    const abort = new AbortController();
    _quizAbort = abort;
    container.innerHTML = _skeletonQuiz();
    try {
        const s = deps.getSettings();
        const result = parseJSON(await deps.callModel(API.sysJson, clozeQuizPrompt(deps.getLang(), s.cefr_level, deps.getNativeLang()), abort.signal));
        if (abort.signal.aborted)
            return;
        if (!Array.isArray(result?.questions) || result.questions.length === 0) {
            container.innerHTML = `<div class="pg-empty-hint">${t('qz.loadFail')}</div>`;
            return;
        }
        const questions = result.questions;
        container.innerHTML = _renderQuizCards(questions) +
            `<div id="pg-quiz-score" class="pg-quiz-score" style="display:none;"></div>`;
        _bindQuizAnswers(container, questions, (correct, wrongIdxs) => {
            _showScore(container, correct, questions.length, wrongIdxs, questions, deps);
        });
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        const msg = e instanceof Error ? e.message : String(e);
        container.innerHTML = `<div class="pg-error-msg">${t('qz.genFail', { msg: escapeHtml(msg) })}</div>`;
    }
    finally {
        if (_quizAbort === abort)
            _quizAbort = null;
    }
}
/**
 * Generates a 25-question reading comprehension half mock exam
 * (10 grammar/vocab + 15 reading) at the user's CEFR level.
 * Independent of chat history.
 */
export async function runReadingExam(container, deps) {
    _quizAbort?.abort();
    const abort = new AbortController();
    _quizAbort = abort;
    container.innerHTML = _skeletonQuiz(6);
    try {
        const s = deps.getSettings();
        const result = parseJSON(await deps.callModel(API.sysJson, readingExamPrompt(deps.getLang(), s.cefr_level, deps.getNativeLang()), abort.signal));
        if (abort.signal.aborted)
            return;
        if (!Array.isArray(result?.questions) || result.questions.length === 0) {
            container.innerHTML = `<div class="pg-empty-hint">${t('qz.loadFail')}</div>`;
            return;
        }
        const questions = result.questions;
        container.innerHTML =
            `<div class="pg-exam-header">
                <span class="pg-exam-title">${t('qz.examTitle')}</span>
                <span class="pg-exam-level">${s.cefr_level}</span>
            </div>` +
                _renderQuizCards(questions) +
                `<div id="pg-quiz-score" class="pg-quiz-score" style="display:none;"></div>`;
        _bindQuizAnswers(container, questions, (correct, wrongIdxs) => {
            _showScore(container, correct, questions.length, wrongIdxs, questions, deps);
        });
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        const msg = e instanceof Error ? e.message : String(e);
        container.innerHTML = `<div class="pg-error-msg">${t('qz.genFail', { msg: escapeHtml(msg) })}</div>`;
    }
    finally {
        if (_quizAbort === abort)
            _quizAbort = null;
    }
}
/**
 * Re-renders only the incorrectly answered questions with shuffled options.
 * Accepts an optional deps so the "save to wrong list" button is available
 * on second-attempt wrong answers — consistent with the first-attempt flow.
 */
export function retryWrongQuestions(container, allQuestions, wrongIdxs, deps) {
    const questions = wrongIdxs.map(i => allQuestions[i]).filter((q) => q !== undefined);
    const total = questions.length;
    let html = `<div class="pg-quiz-retry-header">${t('qz.retryHeader')}</div>`;
    html += questions.map((q, i) => {
        const label = QUIZ_TYPE_LABELS[q.type] || q.type;
        const shuffled = shuffleArray(q.options ?? []);
        return `
            <div class="pg-quiz-card" data-idx="${i}">
                <div class="pg-quiz-type-badge">${label}</div>
                <div class="pg-quiz-q">Q${i + 1}. ${escapeHtml(q.question)}</div>
                <div class="pg-quiz-options">
                    ${shuffled.map(opt => `<button class="pg-opt-btn" data-ans="${escapeHtml(q.answer)}">${escapeHtml(opt)}</button>`).join('')}
                </div>
                <div class="pg-quiz-exp" style="display:none;">
                    <span class="pg-quiz-correct-label">Answer: ${escapeHtml(q.answer)}</span><br>
                    ${escapeHtml(q.explanation)}
                </div>
            </div>`;
    }).join('');
    html += `<div id="pg-quiz-score" class="pg-quiz-score" style="display:none;"></div>`;
    container.innerHTML = html;
    let answered = 0, correct = 0;
    const retryWrongIdxs = []; // track which retry questions were still wrong
    container.querySelectorAll('.pg-opt-btn').forEach(btn => {
        btn.onclick = e => {
            const card = e.target.closest('.pg-quiz-card');
            if (!card || card.classList.contains('pg-answered'))
                return;
            card.classList.add('pg-answered');
            const ok = (e.target.textContent ?? '').trim()
                === (e.target.dataset.ans ?? '').trim();
            e.target.classList.add(ok ? 'pg-opt-correct' : 'pg-opt-wrong');
            card.querySelector('.pg-quiz-exp').style.display = 'block';
            if (ok)
                correct++;
            else
                retryWrongIdxs.push(parseInt(card.dataset.idx ?? '0'));
            answered++;
            // Reuse _showScore so the "save to wrong list" button is injected
            // and a further retry button appears if questions were still missed.
            if (answered === total)
                _showScore(container, correct, total, retryWrongIdxs, questions, deps);
        };
    });
}
// ── Conjugation Drill ─────────────────────────────────────────────────────────
/**
 * Picks a random cached verb and generates a conjugation fill-in drill.
 */
export async function runConjDrill(container, deps) {
    _quizAbort?.abort();
    _quizAbort = new AbortController();
    const { signal } = _quizAbort;
    const lang = deps.getLang();
    const nativeLang = deps.getNativeLang();
    container.innerHTML = _skeletonQuiz(3);
    let entries = [];
    try {
        entries = await deps.getAllConjCache(lang);
    }
    catch { /* empty */ }
    if (entries.length === 0) {
        container.innerHTML = `<div class="pg-error-msg">${t('qz.conjNoCache')}</div>`;
        return;
    }
    // Pick a random cached verb
    const { word, data } = entries[Math.floor(Math.random() * entries.length)];
    const conjJson = JSON.stringify(data);
    let raw = '';
    try {
        raw = await deps.callModel(API.sysJson, conjDrillPrompt(conjJson, lang, nativeLang), signal);
    }
    catch (e) {
        if (e instanceof Error && e.name === 'AbortError')
            return;
        container.innerHTML = `<div class="pg-error-msg">${t('qz.genFail', { msg: escapeHtml(String(e)) })}</div>`;
        return;
    }
    let questions = [];
    try {
        const parsed = parseJSON(raw);
        questions = parsed.questions ?? [];
    }
    catch {
        container.innerHTML = `<div class="pg-error-msg">${t('qz.genFail', { msg: 'parse error: ' + escapeHtml(raw.slice(0, 60)) })}</div>`;
        return;
    }
    if (!questions.length) {
        container.innerHTML = `<div class="pg-error-msg">${t('qz.genFail', { msg: 'no questions returned' })}</div>`;
        return;
    }
    container.innerHTML = `
        <div class="pg-quiz-drill-header">
            <span class="pg-quiz-drill-verb">${escapeHtml(word)}</span>
        </div>
        ${_renderQuizCards(questions)}
        <div id="pg-quiz-score" style="display:none;"></div>`;
    _bindQuizAnswers(container, questions, (correct, wrongIdxs) => {
        _showScore(container, correct, questions.length, wrongIdxs, questions, deps);
    });
}
// ── Targeted Exam ─────────────────────────────────────────────────────────────
/**
 * Picks up to 5 random saved wrong answers and generates 10 targeted questions.
 */
export async function runTargetedExam(container, deps) {
    _quizAbort?.abort();
    _quizAbort = new AbortController();
    const { signal } = _quizAbort;
    const lang = deps.getLang();
    const nativeLang = deps.getNativeLang();
    const s = deps.getSettings();
    const allWrong = s.saved_wrong_answers ?? [];
    if (allWrong.length === 0) {
        container.innerHTML = `
            <div class="pg-error-msg">${t('qz.noWrong')}</div>`;
        return;
    }
    // Pick up to 5 random wrong answers
    const pool = shuffleArray([...allWrong]);
    const selected = pool.slice(0, 5);
    // Show header with count + clear button
    container.innerHTML = `
        <div class="pg-quiz-targeted-header">
            <span>${t('qz.wrongCount', { n: allWrong.length })}</span>
            <button id="pg-targeted-clear" class="pg-btn pg-btn-secondary" style="font-size:0.8em;padding:4px 10px;">
                ${t('qz.clearWrong')}
            </button>
        </div>
        ${_skeletonQuiz(4)}
        <div id="pg-quiz-score" style="display:none;"></div>`;
    container.querySelector('#pg-targeted-clear')?.addEventListener('click', async () => {
        const ok = await deps.askConfirm(t('qz.clearWrong') + '?');
        if (!ok)
            return;
        s.saved_wrong_answers = [];
        deps.saveSettings();
        container.innerHTML = `<div class="pg-error-msg">${t('qz.noWrong')}</div>`;
    });
    let raw = '';
    try {
        raw = await deps.callModel(API.sysJson, targetedExamPrompt(selected, lang, nativeLang), signal);
    }
    catch (e) {
        if (e instanceof Error && e.name === 'AbortError')
            return;
        container.innerHTML = `<div class="pg-error-msg">${t('qz.genFail', { msg: escapeHtml(String(e)) })}</div>`;
        return;
    }
    let questions = [];
    try {
        const parsed = parseJSON(raw);
        questions = parsed.questions ?? [];
    }
    catch {
        container.innerHTML = `<div class="pg-error-msg">${t('qz.genFail', { msg: 'parse error: ' + escapeHtml(raw.slice(0, 60)) })}</div>`;
        return;
    }
    if (!questions.length) {
        container.innerHTML = `<div class="pg-error-msg">${t('qz.genFail', { msg: 'no questions returned' })}</div>`;
        return;
    }
    // Replace skeleton with real cards (keep header)
    const header = container.querySelector('.pg-quiz-targeted-header');
    container.innerHTML = '';
    if (header)
        container.appendChild(header);
    container.insertAdjacentHTML('beforeend', _renderQuizCards(questions));
    container.insertAdjacentHTML('beforeend', `<div id="pg-quiz-score" style="display:none;"></div>`);
    _bindQuizAnswers(container, questions, (correct, wrongIdxs) => {
        _showScore(container, correct, questions.length, wrongIdxs, questions, deps);
    });
}
