// Writing practice (✍️ in the Learn tab): an exam-style task at the learner's
// CEFR level, the learner's text, and rater-style feedback.
//
//   pick a kind ─▶ task (AI) ─▶ write ─▶ feedback (AI): four 0–3 criteria,
//                                         estimated level, corrections, model answer
//   correction archive ─▶ messages the 🪄 input checker corrected (note, delete)
//
// The task and draft survive leaving the mode while the page stays open, so
// switching to a word card and back loses nothing.
//
// Design rules:
//   • No direct ST state reads — everything comes through WritingDeps.
//   • Every AI reply passes through writing-model.ts before it is shown.
import { html, setHtml } from '../html.js';
import { t } from '../i18n.js';
import { notify, askInput } from '../ui.manager.js';
import { writingTaskPrompt, writingFeedbackPrompt } from '../prompts.js';
import { cleanRawMessage } from '../study-scope.js';
import { checksFor, deleteCheck, setCheckNote } from '../check-archive.js';
import { studyLangKey } from '../wordbook.js';
import { lengthTarget, countText, acceptWritingTask, acceptFeedback, diffText, countsCharacters, CRITERIA, } from './writing-model.js';
const KINDS = [
    { id: 'letter', icon: '✉️', title: 'wr.kindLetter', desc: 'wr.kindLetterDesc' },
    { id: 'opinion', icon: '💬', title: 'wr.kindOpinion', desc: 'wr.kindOpinionDesc' },
    { id: 'scene', icon: '🎭', title: 'wr.kindScene', desc: 'wr.kindSceneDesc' },
];
const CRITERION_LABEL = {
    task: 'wr.cTask', coherence: 'wr.cCoherence', accuracy: 'wr.cAccuracy', range: 'wr.cRange',
};
/** Chat history used for in-story tasks: the last few messages, without status windows. */
const SCENE_MESSAGES = 6;
const SCENE_MAX_CHARS = 3000;
let session = null;
/** The request in flight (task or feedback); a new one or leaving cancels it. */
let request = null;
function lengthLabel(target) {
    return t(target.unit === 'chars' ? 'wr.lengthChars' : 'wr.lengthWords', { min: target.min, max: target.max });
}
function sceneText(deps) {
    const s = deps.getSettings();
    const text = (deps.getContext().chat ?? [])
        .map(m => ({ name: m.name, mes: cleanRawMessage(m.mes ?? '', s) }))
        .filter(m => m.mes)
        .slice(-SCENE_MESSAGES)
        .map(m => `${m.name}: ${m.mes}`)
        .join('\n');
    return text.length > SCENE_MAX_CHARS ? text.slice(-SCENE_MAX_CHARS) : text;
}
const errorText = (e) => (e instanceof Error ? e.message : String(e));
// ── Markup ────────────────────────────────────────────────────────────────────
const picker = () => html `
    <div class="pg-quiz-modes">${KINDS.map(k => html `
        <button class="pg-quiz-mode-btn" data-kind="${k.id}">
            <span class="pg-qmode-icon">${k.icon}</span>
            <span class="pg-qmode-title">${t(k.title)}</span>
            <span class="pg-qmode-desc">${t(k.desc)}</span>
        </button>`)}
        <button class="pg-quiz-mode-btn pg-quiz-mode-wide" data-kind="archive">
            <span class="pg-qmode-icon">🪄</span>
            <span class="pg-qmode-text">
                <span class="pg-qmode-title">${t('wr.archive')}</span>
                <span class="pg-qmode-desc">${t('wr.archiveDesc')}</span>
            </span>
            <span class="pg-qmode-count">${t('wr.archiveCount', { n: checksFor(studyLangKey()).length })}</span>
        </button>
    </div>`;
const skeleton = () => html `
    <div class="pg-skeleton-quiz pg-skeleton">
        <div class="pg-skeleton-line pg-skeleton"></div>
        <div class="pg-skeleton-q pg-skeleton"></div>
        <div class="pg-skeleton-opt pg-skeleton"></div>
        <div class="pg-skeleton-opt pg-skeleton"></div>
    </div>`;
function taskCard(s, target) {
    const { task } = s;
    return html `
        <div class="pg-quiz-card pg-write-task">
            <div class="pg-write-meta">${s.level} · ${t(`wr.reg_${task.register}`)} · ${lengthLabel(target)}</div>
            ${task.title && html `<div class="pg-write-title">${task.title}</div>`}
            <div class="pg-write-instr">${task.instructions}</div>
            ${task.points.length > 0 && html `<ul class="pg-write-points">${task.points.map(p => html `<li>${p}</li>`)}</ul>`}
            ${task.native && html `
                <button class="pg-link-btn" data-write="native">${t('wr.showNative')}</button>
                <div class="pg-write-native" hidden>${task.native}</div>`}
        </div>`;
}
const dots = (n) => html `<span class="pg-write-dots" aria-label="${n} / 3">${[0, 1, 2].map(i => html `<i class="${i < n && 'on'}"></i>`)}</span>`;
/** `after` with the changes from `before` marked; plain when they share too little (a translation). */
function diffView(before, after, lang) {
    const parts = diffText(before, after, countsCharacters(lang));
    const kept = parts?.filter(p => p.kind === 'same').reduce((n, p) => n + p.text.length, 0) ?? 0;
    if (!parts || kept < 0.3 * Math.max(before.length, after.length))
        return html `${after}`;
    return html `${parts.map(p => p.kind === 'same' ? html `${p.text}`
        : p.kind === 'del' ? html `<del>${p.text}</del>` : html `<ins>${p.text}</ins>`)}`;
}
function feedbackView(s, f, partial) {
    return html `
        <div class="pg-quiz-card pg-write-feedback">
            <div class="pg-write-level">
                ${f.level && html `<b>${t('wr.levelShown', { level: f.level })}</b>`}
                <span class="pg-write-muted">${t('wr.levelTarget', { level: s.level })} · ${t('wr.estimate')}</span>
            </div>
            <div class="pg-write-scores">${CRITERIA.map(c => html `
                <div class="pg-write-score"><span>${t(CRITERION_LABEL[c])}</span>${dots(f.scores[c])}</div>`)}
            </div>
            ${f.summary && html `<p class="pg-write-summary">${f.summary}</p>`}
            ${partial && html `<p class="pg-write-muted">${t('wr.partial')}</p>`}

            <div class="pg-write-head">${t('wr.corrected')}</div>
            <div class="pg-write-diff">${diffView(s.rated ?? s.text, f.corrected, s.lang)}</div>

            ${f.errors.length > 0 && html `
                <div class="pg-write-head">${t('wr.errors', { n: f.errors.length })}</div>
                <ul class="pg-write-errors">${f.errors.map(e => html `
                    <li>
                        <div><del>${e.original}</del> → <ins>${e.correction}</ins> <span class="pg-write-type">${t(`wr.type_${e.type}`)}</span></div>
                        ${e.explanation && html `<div class="pg-write-muted">${e.explanation}</div>`}
                    </li>`)}
                </ul>
                <button class="pg-wb-row-btn" data-write="save-errors">${t('wr.saveErrors')}</button>`}

            ${f.model && html `
                <button class="pg-link-btn" data-write="model">${t('wr.showModel')}</button>
                <div class="pg-write-model-wrap" hidden>
                    <div class="pg-write-head">${t('wr.model')}</div>
                    <div class="pg-write-model">${f.model}</div>
                </div>`}
        </div>`;
}
// ── Views ─────────────────────────────────────────────────────────────────────
function renderPicker(container, deps) {
    container.onclick = null;
    setHtml(container, html `${picker()}<div class="pg-write-area"></div>`);
    container.querySelector('.pg-quiz-modes')?.addEventListener('click', e => {
        const kind = e.target.closest('[data-kind]')?.dataset.kind;
        if (kind === 'archive')
            renderArchive(container, deps);
        else if (kind)
            void newTask(container, deps, kind);
    });
}
async function newTask(container, deps, kind) {
    const lang = deps.getLang();
    const level = deps.getSettings().cefr_level;
    const target = lengthTarget(level, lang);
    const scene = kind === 'scene' ? sceneText(deps) : '';
    const area = container.querySelector('.pg-write-area') ?? container;
    if (kind === 'scene' && !scene) {
        setHtml(area, html `<div class="pg-empty-hint">${t('wr.noScene')}</div>`);
        return;
    }
    request?.abort();
    const abort = request = new AbortController();
    setHtml(area, skeleton());
    try {
        const { data } = await deps.ai.json({
            prompt: writingTaskPrompt(kind, lang, level, deps.getNativeLang(), lengthLabel(target), scene),
            signal: abort.signal,
            accept: acceptWritingTask,
        });
        if (abort.signal.aborted)
            return;
        session = { lang, level, kind, task: data, text: '' };
        renderSession(container, deps);
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        setHtml(area, html `<div class="pg-error-msg">${t('wr.taskFail', { msg: errorText(e) })}</div>`);
    }
}
function renderSession(container, deps, partial = false) {
    const s = session;
    if (!s) {
        renderPicker(container, deps);
        return;
    }
    const target = lengthTarget(s.level, s.lang);
    setHtml(container, html `
        ${taskCard(s, target)}
        <textarea class="pg-soft-input pg-write-text" spellcheck="false" placeholder="${t('wr.placeholder')}"></textarea>
        <div class="pg-write-bar">
            <span class="pg-write-count"></span>
            <span class="pg-wb-count-spacer"></span>
            <button class="pg-wb-row-btn" data-write="new">${t('wr.newTask')}</button>
            <button class="pg-btn pg-btn-primary pg-btn-compact" data-write="rate">${t('wr.rate')}</button>
        </div>
        <div class="pg-write-result">${s.feedback && feedbackView(s, s.feedback, partial)}</div>`);
    const box = container.querySelector('.pg-write-text');
    const count = container.querySelector('.pg-write-count');
    if (!box || !count)
        return;
    const showCount = () => {
        const n = countText(box.value, target.unit);
        count.textContent = `${n} / ${lengthLabel(target)}`;
        count.classList.toggle('pg-write-ok', n >= target.min && n <= target.max);
    };
    box.value = s.text;
    showCount();
    box.addEventListener('input', () => { s.text = box.value; showCount(); });
    container.onclick = e => {
        const action = e.target.closest('[data-write]')?.dataset.write;
        const show = (sel, btn) => {
            const el = container.querySelector(sel);
            if (el) {
                el.hidden = !el.hidden;
                btn.remove();
            }
        };
        if (action === 'new') {
            request?.abort();
            session = null;
            renderPicker(container, deps);
        }
        if (action === 'rate')
            void rate(container, deps);
        if (action === 'native')
            show('.pg-write-native', e.target);
        if (action === 'model')
            show('.pg-write-model-wrap', e.target);
        if (action === 'save-errors')
            saveErrors(deps, e.target);
    };
}
async function rate(container, deps) {
    const s = session;
    if (!s)
        return;
    const target = lengthTarget(s.level, s.lang);
    const text = s.text.trim();
    if (countText(text, target.unit) < Math.min(10, target.min)) {
        notify(t('wr.tooShort'), 'warn', 3000);
        return;
    }
    request?.abort();
    const abort = request = new AbortController();
    const result = container.querySelector('.pg-write-result');
    const button = container.querySelector('[data-write="rate"]');
    if (result)
        setHtml(result, skeleton());
    if (button)
        button.disabled = true;
    try {
        const { data, partial } = await deps.ai.json({
            prompt: writingFeedbackPrompt(s.task, text, s.lang, s.level, deps.getNativeLang(), lengthLabel(target)),
            signal: abort.signal,
            accept: acceptFeedback(text),
        });
        if (abort.signal.aborted || session !== s)
            return;
        // Rating the same text again is not more study
        if (s.rated !== text)
            deps.logStudy?.();
        s.feedback = data;
        s.rated = text;
        renderSession(container, deps, partial);
        container.querySelector('.pg-write-feedback')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        if (result)
            setHtml(result, html `<div class="pg-error-msg">${t('wr.rateFail', { msg: errorText(e) })}</div>`);
    }
    finally {
        if (button && request === abort)
            button.disabled = false;
    }
}
/** The corrections go to the wrong-answer list, so "Weak points" quizzes practise them. */
function saveErrors(deps, btn) {
    const errors = session?.feedback?.errors ?? [];
    const saved = deps.wrongAnswers();
    const known = new Set(saved.map(w => w.question));
    const added = errors
        .map(e => ({
        type: e.type === 'vocabulary' ? 'vocab' : 'grammar',
        question: t('wr.wrongQuestion', { text: e.original }),
        options: [],
        answer: e.correction,
        explanation: e.explanation,
        savedAt: Date.now(),
    }))
        .filter(w => !known.has(w.question));
    if (added.length)
        deps.saveWrongAnswers([...saved, ...added]);
    btn.textContent = t('qz.wrongSaved');
    btn.disabled = true;
}
// ── Correction archive ────────────────────────────────────────────────────────
function renderArchive(container, deps) {
    const lang = deps.getLang();
    const checks = checksFor(studyLangKey());
    const date = (at) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    setHtml(container, html `
        <div class="pg-write-bar">
            <span class="pg-write-title">${t('wr.archive')}</span>
            <span class="pg-wb-count-spacer"></span>
            <button class="pg-wb-row-btn" data-write="tasks">${t('wr.backToTasks')}</button>
        </div>
        ${checks.length ? checks.map(c => html `
        <div class="pg-quiz-card pg-check-card" data-id="${c.id}">
            <div class="pg-write-meta">${date(c.at)}</div>
            <div class="pg-check-original">${c.original}</div>
            <div class="pg-write-diff">${diffView(c.original, c.grammar, lang)}</div>
            ${c.natural && c.natural !== c.grammar && html `
                <div class="pg-check-natural"><span class="pg-write-type">${t('wr.natural')}</span> ${c.natural}</div>`}
            ${c.explanation && html `<div class="pg-write-muted pg-check-why">${c.explanation}</div>`}
            ${c.note && html `<div class="pg-check-note">${c.note}</div>`}
            <div class="pg-check-actions">
                <button class="pg-wb-row-btn" data-write="note">${t('wr.note')}</button>
                <button class="pg-wb-row-btn pg-wb-row-btn-danger" data-write="delete">${t('wb.delete')}</button>
            </div>
        </div>`) : html `<div class="pg-empty-hint">${t('wr.archiveEmpty')}</div>`}`);
    container.onclick = async (e) => {
        const btn = e.target.closest('[data-write]');
        const id = btn?.closest('[data-id]')?.dataset.id;
        const action = btn?.dataset.write;
        if (action === 'tasks') {
            renderPicker(container, deps);
            return;
        }
        if (!id)
            return;
        if (action === 'delete')
            deleteCheck(id);
        if (action === 'note') {
            const note = await askInput(t('wr.note'), { initial: checks.find(c => c.id === id)?.note ?? '' });
            if (note === null)
                return;
            setCheckNote(id, note);
        }
        renderArchive(container, deps);
    };
}
/** Shows the writing mode: the current task and draft if there is one for this language and level, else the task kinds. */
export function renderWriting(container, deps) {
    if (session && (session.lang !== deps.getLang() || session.level !== deps.getSettings().cefr_level))
        session = null;
    if (session)
        renderSession(container, deps);
    else
        renderPicker(container, deps);
}
/** Leaving the mode cancels a request in flight (the draft stays). */
export function leaveWriting() {
    request?.abort();
    request = null;
}
