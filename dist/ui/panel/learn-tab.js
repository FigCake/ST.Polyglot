// ════════════════════════════
// Polyglot  ui/panel/learn-tab.ts
// ════════════════════════════
// Learn tab: the word-detail card plus a bar of study modes.
//
//   ┌ detail ┐   click a mode   ┌ ← back ┐
//   │  card  │  ────────────▶   │  mode  │   (back, or a new word, returns to detail)
//   └─ bar ──┘                  └─ bar ──┘
//
// Modes and quiz variants are declared as data (MODES / QUIZ_VARIANTS), so
// adding one is a single table entry.
//
// Dependencies: runtime.ts, speech.ts, html.ts, ui.manager.ts, features/*,
//               ui/wordbook-ui.ts (renderDetail), conj-cache.ts
import { getSettings, getLang, getNativeLang, ai, getContext } from '../../runtime.js';
import { speak, hasSpeechRecognition, runPronunciationCheck, setActiveRecognition, getActiveRecognition, abortActiveRecognition, } from '../../speech.js';
import { html, setHtml } from '../../html.js';
import { askConfirm } from '../../ui.manager.js';
import { t } from '../../i18n.js';
import { getAllConjEntries } from '../../conj-cache.js';
import { wrongAnswersData, replaceUserData } from '../../data-store.js';
import { renderDetail } from '../wordbook-ui.js';
import { renderFlashcard } from '../../features/flashcard.js';
import { renderSpeaking } from '../../features/speaking.js';
import { renderMatchSetup } from '../../features/match.js';
import { runMiniQuiz, runClozeQuiz, runReadingExam, runConjDrill, runTargetedExam, } from '../../features/quiz.js';
// ── Feature wiring ────────────────────────────────────────────────────────────
/** Starts a mic session and tracks it, so leaving the mode or closing the panel stops the microphone. */
function pronounce(target, micBtn, resultEl, onSettled) {
    const session = runPronunciationCheck(target, getLang(), micBtn, resultEl, onSettled);
    setActiveRecognition(session);
    return session;
}
const quizDeps = {
    ai, getContext, getSettings, getLang, getNativeLang, askConfirm,
    wrongAnswers: wrongAnswersData,
    saveWrongAnswers: wrongAnswers => replaceUserData({ wrongAnswers }),
    // Language-scoped so tables from a previously studied language are skipped
    getAllConjCache: (lang) => getAllConjEntries(lang),
};
const QUIZ_VARIANTS = [
    { id: 'quick', icon: '⚡', title: 'qz.modeQuick', desc: 'qz.modeQuickDesc', run: c => runMiniQuiz(c, quizDeps, 3, 5) },
    { id: 'full', icon: '📝', title: 'qz.modeFull', desc: 'qz.modeFullDesc', run: c => runMiniQuiz(c, quizDeps, 6, 20) },
    { id: 'cloze', icon: '✏️', title: 'qz.modeCloze', desc: 'qz.modeClozeDesc', run: c => runClozeQuiz(c, quizDeps) },
    { id: 'exam', icon: '🎓', title: 'qz.modeExam', desc: 'qz.modeExamDesc', run: c => runReadingExam(c, quizDeps) },
    { id: 'conj', icon: '🔀', title: 'qz.modeConj', desc: 'qz.modeConjDesc', run: c => runConjDrill(c, quizDeps) },
    { id: 'targeted', icon: '🎯', title: 'qz.modeTargeted', desc: 'qz.modeTargetedDesc', run: c => runTargetedExam(c, quizDeps) },
];
function renderQuizPicker(container) {
    setHtml(container, html `
        <div class="pg-quiz-modes">${QUIZ_VARIANTS.map(v => html `
            <button class="pg-quiz-mode-btn" data-quiz="${v.id}">
                <span class="pg-qmode-icon">${v.icon}</span>
                <span class="pg-qmode-title">${t(v.title)}</span>
                <span class="pg-qmode-desc">${t(v.desc)}</span>
            </button>`)}
        </div>
        <div id="pg-quiz-container" class="pg-quiz-container"></div>`);
    const host = container.querySelector('.pg-quiz-container');
    container.querySelector('.pg-quiz-modes')?.addEventListener('click', e => {
        const id = e.target.closest('[data-quiz]')?.dataset.quiz;
        const variant = QUIZ_VARIANTS.find(v => v.id === id);
        if (variant && host)
            variant.run(host);
    });
}
const MODES = [
    {
        id: 'flash', icon: '🃏', key: 'pnl.learn.flash',
        render: c => renderFlashcard(c, {
            ai, getLang, getNativeLang, getSettings, speak,
            hasSpeechRecog: hasSpeechRecognition,
            runPronunCheck: pronounce,
            setActiveRecog: setActiveRecognition,
            getActiveRecog: getActiveRecognition,
        }),
    },
    { id: 'quiz', icon: '🎯', key: 'pnl.learn.quiz', render: renderQuizPicker },
    { id: 'match', icon: '🎮', key: 'pnl.learn.match', render: renderMatchSetup },
    {
        id: 'speak', icon: '🎤', key: 'pnl.learn.speak',
        render: c => renderSpeaking(c, {
            speak, getLang, hasSpeechRecognition, runPronunciationCheck: pronounce,
        }),
    },
];
// ── Learn tab ─────────────────────────────────────────────────────────────────
export class LearnTab {
    actions;
    el = document.createElement('div');
    detail = document.createElement('div');
    mode = document.createElement('div');
    bar = document.createElement('div');
    constructor(initial, actions) {
        this.actions = actions;
        this.el.className = 'pg-box-pane pg-learn-tab';
        this.detail.className = 'pg-learn-detail-area';
        this.mode.className = 'pg-learn-mode-area';
        this.bar.className = 'pg-learn-bar';
        this.mode.hidden = true;
        setHtml(this.bar, html `${MODES.map(m => html `
            <button class="pg-learn-mode-btn" data-mode="${m.id}" title="${t(m.key)}" aria-label="${t(m.key)}">${m.icon}</button>`)}`);
        this.bar.addEventListener('click', e => {
            const id = e.target.closest('[data-mode]')?.dataset.mode;
            if (id)
                this.enter(id);
        });
        renderDetail(this.detail, initial, actions);
        this.el.append(this.detail, this.mode, this.bar);
    }
    /** Shows a word in the detail card, leaving any active mode. */
    showDetail(data) {
        renderDetail(this.detail, data, this.actions);
        this.exit();
    }
    enter(id) {
        const mode = MODES.find(m => m.id === id);
        if (!mode)
            return;
        const back = Object.assign(document.createElement('button'), {
            className: 'pg-learn-back-btn pg-btn pg-btn-secondary',
            textContent: t('pnl.learn.back'),
            onclick: () => this.exit(),
        });
        const inner = Object.assign(document.createElement('div'), { className: 'pg-learn-mode-inner' });
        abortActiveRecognition();
        this.mode.replaceChildren(back, inner);
        this.setActive(id);
        mode.render(inner);
    }
    exit() {
        if (this.mode.hidden)
            return;
        abortActiveRecognition();
        this.mode.replaceChildren();
        this.setActive(null);
    }
    setActive(id) {
        this.detail.hidden = id !== null;
        this.mode.hidden = id === null;
        this.bar.querySelectorAll('[data-mode]')
            .forEach(b => b.classList.toggle('active', b.dataset.mode === id));
    }
}
