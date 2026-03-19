// ════════════════════════════
// Polyglot  features/speaking.ts
// ════════════════════════════
// Blind Dictation and Shadowing mode — flashcard-style listening/speaking drills.
//
// Two sub-modes per card (randomly assigned or user-selected):
//   Dictation  — hear the audio, type what you heard → compare against original
//   Shadowing  — hear the audio, speak it back → pronunciation score via SpeechRecognition
//
// Design rules:
//   • Pure feature module — no direct ST state reads.
//   • speak / runPronunciationCheck are injected via SpeakingDeps.
//   • Card pool = all wordbook entries with a non-empty word field.
import { shuffleArray } from '../utils.js';
import { escapeHtml } from '../ui.manager.js';
import { loadWordbook } from '../wordbook.js';
import { t } from '../i18n.js';
// ── Internal state ─────────────────────────────────────────────────────────────
let _currentRecog = null;
/** Tracks the active shadowing MutationObserver so it can be disconnected on card change. */
let _currentObserver = null;
// ── Helpers ────────────────────────────────────────────────────────────────────
export function _levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
}
export function _dictationScore(target, input) {
    // eslint-disable-next-line no-misleading-character-class
    const a = target.toLowerCase().trim().replace(/[^a-z0-9\u00c0-\u017e\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u3040-\u30ff\u4e00-\u9fff\uAC00-\uD7A3\u1100-\u11FF ]/gu, '');
    // eslint-disable-next-line no-misleading-character-class
    const b = input.toLowerCase().trim().replace(/[^a-z0-9\u00c0-\u017e\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u3040-\u30ff\u4e00-\u9fff\uAC00-\uD7A3\u1100-\u11FF ]/gu, '');
    if (!a)
        return 100;
    if (!b)
        return 0;
    const dist = _levenshtein(a, b);
    return Math.max(0, Math.round(100 * (1 - dist / Math.max(a.length, b.length))));
}
function _scoreLabel(score) {
    if (score >= 95)
        return { label: t('tts.perfect'), cls: 'pg-pronun-perfect' };
    if (score >= 75)
        return { label: t('tts.great'), cls: 'pg-pronun-great' };
    if (score >= 50)
        return { label: t('tts.keep'), cls: 'pg-pronun-ok' };
    return { label: t('tts.tryAgain'), cls: 'pg-pronun-tryagain' };
}
// ── Main renderer ─────────────────────────────────────────────────────────────
export function renderSpeaking(container, deps) {
    const wb = loadWordbook().filter(e => e.word?.trim());
    const lang = deps.getLang();
    if (wb.length === 0) {
        container.innerHTML = `<div class="pg-error-msg">${t('speak.noEntries')}</div>`;
        return;
    }
    let pool = shuffleArray([...wb]);
    let idx = 0;
    let subMode = 'random';
    // ── Shell ─────────────────────────────────────────────────────────────────
    container.innerHTML = `
        <div class="pg-speak-controls">
            <div class="pg-speak-mode-group">
                <button class="pg-speak-mode-btn active" data-mode="random">${t('speak.modeRandom')}</button>
                <button class="pg-speak-mode-btn" data-mode="dictation">${t('speak.modeDictation')}</button>
                <button class="pg-speak-mode-btn" data-mode="shadowing">${t('speak.modeShadowing')}</button>
            </div>
            <span class="pg-speak-progress" id="pg-speak-progress">1 / ${pool.length}</span>
        </div>
        <div id="pg-speak-card-area"></div>`;
    // Mode switcher
    container.querySelectorAll('.pg-speak-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.pg-speak-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            subMode = btn.dataset.mode;
            pool = shuffleArray([...wb]);
            idx = 0;
            renderCard();
        });
    });
    // ── Card renderer ─────────────────────────────────────────────────────────
    function renderCard() {
        if (_currentRecog) {
            try {
                _currentRecog.abort();
            }
            catch { /* ignore */ }
            _currentRecog = null;
        }
        // Disconnect any live shadowing observer so it doesn't fire on the DOM
        // of a card that is about to be replaced (prevents stale-closure callbacks
        // and eliminates the observer leak when cards are flipped rapidly).
        if (_currentObserver) {
            _currentObserver.disconnect();
            _currentObserver = null;
        }
        const progressEl = container.querySelector('#pg-speak-progress');
        if (progressEl)
            progressEl.textContent = `${idx + 1} / ${pool.length}`;
        if (idx >= pool.length) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            container.querySelector('#pg-speak-card-area').innerHTML =
                `<div class="pg-score-perfect">${t('speak.done')}</div>
                 <button id="pg-speak-restart" class="pg-btn pg-btn-secondary pg-btn-full" style="margin-top:12px;">${t('speak.restart')}</button>`;
            container.querySelector('#pg-speak-restart')?.addEventListener('click', () => {
                pool = shuffleArray([...wb]);
                idx = 0;
                renderCard();
            });
            return;
        }
        const entry = pool[idx];
        const mode = subMode === 'random' ? (Math.random() < 0.5 ? 'dictation' : 'shadowing') : subMode;
        // Fall back to dictation if SpeechRecognition unavailable
        const effectiveMode = (mode === 'shadowing' && !deps.hasSpeechRecognition()) ? 'dictation' : mode;
        const modeLabel = effectiveMode === 'dictation' ? t('speak.modeDictation') : t('speak.modeShadowing');
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const area = container.querySelector('#pg-speak-card-area');
        if (effectiveMode === 'dictation') {
            area.innerHTML = `
                <div class="pg-speak-card">
                    <div class="pg-speak-card-badge">${escapeHtml(modeLabel)}</div>
                    <button class="pg-speak-play-btn" id="pg-speak-play" title="${t('speak.play')}">🔊</button>
                    <div class="pg-speak-hint">${t('speak.dictHint')}</div>
                    <textarea id="pg-speak-input" class="pg-speak-textarea text_pole"
                        placeholder="${t('speak.dictPh')}" rows="2" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
                    <button id="pg-speak-check" class="pg-btn pg-btn-primary pg-btn-full">${t('speak.check')}</button>
                    <div id="pg-speak-result" class="pg-pronun-result"></div>
                    <div id="pg-speak-reveal" style="display:none;" class="pg-speak-reveal"></div>
                    <button id="pg-speak-next" class="pg-btn pg-btn-secondary pg-btn-full" style="display:none;margin-top:8px;">${t('speak.next')}</button>
                </div>`;
            area.querySelector('#pg-speak-play')?.addEventListener('click', () => {
                deps.speak(entry.word, lang);
            });
            area.querySelector('#pg-speak-check')?.addEventListener('click', () => {
                const input = (area.querySelector('#pg-speak-input')?.value ?? '').trim();
                if (!input)
                    return;
                const score = _dictationScore(entry.word, input);
                const { label, cls } = _scoreLabel(score);
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const resultEl = area.querySelector('#pg-speak-result');
                resultEl.className = `pg-pronun-result ${cls}`;
                resultEl.textContent = `${score}% — ${label}`;
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const revealEl = area.querySelector('#pg-speak-reveal');
                revealEl.style.display = '';
                revealEl.innerHTML = `<span class="pg-speak-answer">${escapeHtml(entry.word)}</span>
                    ${entry.meaning ? `<span class="pg-speak-meaning">${escapeHtml(entry.meaning)}</span>` : ''}`;
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                area.querySelector('#pg-speak-next').style.display = '';
                area.querySelector('#pg-speak-check').style.display = 'none';
            });
        }
        else {
            // Shadowing
            area.innerHTML = `
                <div class="pg-speak-card">
                    <div class="pg-speak-card-badge">${escapeHtml(modeLabel)}</div>
                    <button class="pg-speak-play-btn" id="pg-speak-play" title="${t('speak.play')}">🔊</button>
                    <div class="pg-speak-hint">${t('speak.shadHint')}</div>
                    <div class="pg-speak-mic-row">
                        <button id="pg-speak-mic" class="pg-speak-mic-btn" title="${t('speak.mic')}">🎤</button>
                        <div id="pg-speak-result" class="pg-pronun-result"></div>
                    </div>
                    <div id="pg-speak-reveal" style="display:none;" class="pg-speak-reveal"></div>
                    <button id="pg-speak-next" class="pg-btn pg-btn-secondary pg-btn-full" style="display:none;margin-top:8px;">${t('speak.next')}</button>
                </div>`;
            area.querySelector('#pg-speak-play')?.addEventListener('click', () => {
                deps.speak(entry.word, lang);
            });
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const micBtn = area.querySelector('#pg-speak-mic');
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const resultEl = area.querySelector('#pg-speak-result');
            micBtn.addEventListener('click', () => {
                if (micBtn.dataset.active === 'true') {
                    _currentRecog?.abort();
                    return;
                }
                _currentRecog = deps.runPronunciationCheck(entry.word, micBtn, resultEl);
                // Show reveal + next after result
                const observer = new MutationObserver(() => {
                    if (resultEl.textContent && resultEl.textContent !== t('tts.listening')) {
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        const revealEl = area.querySelector('#pg-speak-reveal');
                        revealEl.style.display = '';
                        revealEl.innerHTML = `<span class="pg-speak-answer">${escapeHtml(entry.word)}</span>
                            ${entry.meaning ? `<span class="pg-speak-meaning">${escapeHtml(entry.meaning)}</span>` : ''}`;
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        area.querySelector('#pg-speak-next').style.display = '';
                        observer.disconnect();
                        _currentObserver = null; // release module-level ref after natural completion
                    }
                });
                _currentObserver = observer; // register so renderCard() can disconnect early
                observer.observe(resultEl, { childList: true, characterData: true, subtree: true });
            });
        }
        // Auto-play on card open
        deps.speak(entry.word, lang);
        // Next button
        area.querySelector('#pg-speak-next')?.addEventListener('click', () => {
            idx++;
            renderCard();
        });
    }
    renderCard();
}
