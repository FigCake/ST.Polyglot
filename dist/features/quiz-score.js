// The score shown when a quiz (multiple choice or typed) ends: right / total,
// then a "Retry the N wrong ones" button or the all-correct line. The caller
// binds the button (.pg-quiz-retry).
import { html } from '../html.js';
import { t } from '../i18n.js';
export const scoreView = (total, wrong) => html `
    <div class="pg-score-text">${t('qz.score', { n: total - wrong, total })}</div>
    ${wrong
    ? html `<button class="pg-btn pg-btn-secondary pg-btn-full pg-quiz-retry">${t('qz.retry', { n: wrong })}</button>`
    : html `<div class="pg-score-perfect">${t('qz.allCorrect')}</div>`}`;
