// ════════════════════════════
// Polyglot  index.ts
// ════════════════════════════
import { openPanel, buildTabView, askConfirm, notify, escapeHtml } from './ui.manager.js';
import { buildSettingsPanel, initSettingsUI } from './ui/settings-ui.js';
import { setupTextSelectionTooltip, setupTapToTranslate, removeTapBubbles, abortAllTapTranslate, abortQuickLookup, initTapTranslate, runQuickLookup } from './ui/tap-translate.js';
import { renderWordbook, initWbUI, renderDetailTab, addToWordbook, triggerImport } from './ui/wordbook-ui.js';
import { KEY, DELAY } from './constants.js';
import { getLangFromSettings, getNativeLangFromSettings } from './utils.js';
import { runMiniQuiz, runClozeQuiz, runReadingExam, runConjDrill, runTargetedExam } from './features/quiz.js';
import { renderSpeaking } from './features/speaking.js';
import { runChecker } from './features/checker.js';
import { renderFlashcard } from './features/flashcard.js';
import { renderMatchSetup } from './features/match.js';
import { runReanalysis, abortReanalysis, isReanalysisRunning } from './features/reanalysis.js';
// Other types are imported directly in each module (wordbook-ui.ts, tap-translate.ts, etc.)
import { clearAllConjCache, pruneOrphanSets, loadWordbook, saveWordbook, exportToCSV, exportToFlashcardTxt, exportToPDF, } from './wordbook.js';
import { callModel as _apiCallModel } from './api.js';
import { getAllConjEntries } from './conj-cache.js';
import { annotatedMsgs, annotationCache, mesObservers, annotateAborts, setOpenPanelFn, unpersistAnnotation, restoreAnnotations, restoreWithRetry, stripHighlightsFromEl, clearCurrentChatAnnotations, injectAnnotateButtons, runAnnotator, } from './annotator.js';
// ═ Direct ST imports
// extension_settings: direct reference to the live settings object (avoids snapshot issues via getContext)
// saveSettingsDebounced: direct reference to the ST save function
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { saveSettingsDebounced, eventSource, event_types } from '../../../../../script.js';
import { t } from './i18n.js';
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { extension_settings, getContext } from '../../../../extensions.js';
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { SlashCommand } from '../../../../slash-commands/SlashCommand.js';
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../../slash-commands/SlashCommandArgument.js';
// ════════════════════════════
// Domain Types
// ════════════════════════════
// Types → see types.ts
// Conjugation Cache → see conj-cache.ts
// clearAllConjCache() below wraps clearConjCacheStore() + wordbook flag reset.
// ═ Provider → ST chat_completion_source mapping
// Provider config tables → see api.ts
// ═ Default settings
const DEFAULT_SETTINGS = Object.freeze({
    enabled_checker: true,
    enabled_annotator: true,
    language: 'English',
    language_custom: '',
    native_lang: 'en', // explanation / UI language: 'ko'|'en'|'it'|'es'|'custom'
    native_lang_custom: '',
    cefr_level: 'B1',
    // ═ AI provider settings
    // provider: 'st' | 'openai' | 'claude' | 'google' | 'openrouter' | 'deepseek' | 'vertexai' | 'custom'
    provider: 'st',
    model: '', // selected model name (unused when provider is 'st')
    // last-used model per provider — restored when switching back to a provider
    _model_history: {
        openai: 'gpt-5.1',
        claude: 'claude-sonnet-4-6',
        google: 'gemini-3.1-pro-preview',
        openrouter: 'google/gemini-3.1-pro-preview',
        deepseek: 'deepseek-chat-v3-5',
        vertexai: 'gemini-3.1-pro-preview',
    },
    // ST default connection only (provider='st')
    route_chat_source: '',
    route_model: '',
    // Custom provider only (provider='custom')
    ext_api_key: '',
    ext_base_url: '',
    max_tokens: 30000,
    dict_url_custom: '',
    _sets: [], // [{ id, name }]  — global word sets
    panel_theme: 'dark',
    panel_bg_image: '',
    panel_floating: false,
    saved_wrong_answers: [],
    auto_save_idioms: true,
    // _annotations intentionally absent — stored in chatMetadata
});
function getSettings() {
    // Use the directly-imported extension_settings instead of going through getContext().
    // Some ST versions return a snapshot via getContext().extensionSettings;
    // importing directly guarantees a live reference.
    if (!extension_settings[KEY.module]) {
        extension_settings[KEY.module] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extension_settings[KEY.module];
    // Back-fill any keys missing from saved settings (e.g. after an extension update)
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(s, k)) {
            s[k] = Array.isArray(v) ? [] : (v && typeof v === 'object') ? { ...v } : v;
        }
    }
    // Back-fill any provider keys missing from _model_history (older save files)
    const defaultHistory = DEFAULT_SETTINGS._model_history;
    for (const [p, m] of Object.entries(defaultHistory)) {
        if (!s._model_history[p])
            s._model_history[p] = m;
    }
    // ═ Legacy migration: ext_provider → provider/model
    if (Object.hasOwn(s, 'ext_provider')) {
        const legacyMap = { anthropic: 'claude', openai: 'openai', openrouter: 'openrouter', custom: 'custom' };
        if (s.ext_provider && s.ext_provider !== 'none') {
            s.provider = legacyMap[s.ext_provider] ?? 'st';
            if (s.ext_model)
                s.model = s.ext_model;
        }
        delete s.ext_provider;
        delete s.ext_model;
    }
    return s;
}
function save() { saveSettingsDebounced(); }
// ════════════════════════════
// Annotation Persistence — save / restore / clear
// ════════════════════════════
/** Returns a stable identifier for the current chat, used to detect chat switches. */
function getLang() { return getLangFromSettings(getSettings()); }
function getNativeLang() { return getNativeLangFromSettings(getSettings()); }
// ════════════════════════════
// AI API — unified provider router (AbortSignal support)
// ════════════════════════════
// Implementation → see api.ts.
// This wrapper injects getSettings() so callers don't need to.
/** Calls the AI model using the current provider settings. */
function callModel(systemPrompt, userPrompt, signal) {
    return _apiCallModel(getSettings(), systemPrompt, userPrompt, signal);
}
// levelClass, levelLabel → see utils.ts
function _langCode(lang) {
    const l = lang.toLowerCase();
    if (l.includes('spanish') || l.includes('español'))
        return 'es-ES';
    if (l.includes('italian') || l.includes('italiano'))
        return 'it-IT';
    if (l.includes('french') || l.includes('français'))
        return 'fr-FR';
    if (l.includes('german') || l.includes('deutsch'))
        return 'de-DE';
    if (l.includes('japanese') || l.includes('日本語'))
        return 'ja-JP';
    if (l.includes('chinese') || l.includes('中文'))
        return 'zh-CN';
    if (l.includes('korean') || l.includes('한국어'))
        return 'ko-KR';
    if (l.includes('portuguese'))
        return 'pt-PT';
    return 'en-US';
}
/**
 * Speaks text aloud using the Web Speech API.
 * @param {string} text  Text to speak
 * @param {string} lang  Target language name (from getLang())
 */
// Kept at module level so Chromium's GC cannot collect it mid-playback
// and cut long sentences short. Released automatically via onend callback.
let _currentUtterance = null;
function speakWord(text, lang) {
    if (!('speechSynthesis' in window)) {
        notify(t('tts.noSupport'), 'err', 2500);
        return;
    }
    window.speechSynthesis.cancel(); // stop any ongoing speech
    _currentUtterance = new SpeechSynthesisUtterance(text);
    _currentUtterance.lang = _langCode(lang);
    _currentUtterance.rate = 0.85; // slightly slower — better for learners
    _currentUtterance.onend = () => { _currentUtterance = null; }; // release on completion
    window.speechSynthesis.speak(_currentUtterance);
}
// ════════════════════════════
// Pronunciation Evaluation
// ════════════════════════════
/** Returns true if the browser supports SpeechRecognition. */
function _hasSpeechRecognition() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}
/**
 * Strips diacritic marks and lowercases a string.
 * e.g. é→e, ü→u — accent differences are ignored during scoring.
 */
function _normalizeForPronun(text) {
    return text
        .toLowerCase()
        .normalize('NFD') // decompose into base + combining chars
        .replace(/[\u0300-\u036f]/g, '') // remove combining diacritical marks
        .replace(/[^a-z0-9\s'-]/g, '') // strip punctuation (keep apostrophe/hyphen)
        .trim();
}
/**
 * Computes the Levenshtein edit distance between two strings.
 */
function _levenshtein(a, b) {
    const m = a.length, n = b.length;
    // handle empty strings
    if (m === 0)
        return n;
    if (n === 0)
        return m;
    // rolling single-row DP to save memory
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
        const curr = [i];
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, // insert
            prev[j] + 1, // delete
            prev[j - 1] + cost // replace
            );
        }
        prev = curr;
    }
    return prev[n];
}
/**
 * Returns a pronunciation accuracy score from 0 to 100.
 * Based on normalised Levenshtein similarity.
 */
function _pronunciationScore(target, recognized) {
    const a = _normalizeForPronun(target);
    const b = _normalizeForPronun(recognized);
    if (!a)
        return 0;
    if (a === b)
        return 100;
    const dist = _levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    return Math.max(0, Math.round((1 - dist / maxLen) * 100));
}
/**
 * Runs a pronunciation check via the Web Speech API.
 * @param {string}      targetWord  The word to compare against
 * @param {HTMLElement} micBtn      Mic button element (updated with recording state)
 * @param {HTMLElement} resultEl    Element where the score is rendered
 * @returns {SpeechRecognition}     Call .abort() to cancel
 */
function runPronunciationCheck(targetWord, micBtn, resultEl) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        resultEl.className = 'pg-pronun-result pg-pronun-error';
        resultEl.textContent = t('tts.noRecog');
        return null;
    }
    const recognition = new SR();
    recognition.lang = _langCode(getLang());
    recognition.continuous = false; // one utterance only
    recognition.interimResults = false; // final result only
    recognition.maxAlternatives = 3; // consider up to 3 candidates
    let hasResult = false; // ensures only the first of onresult/onerror is processed
    // ═ Update button to recording state
    micBtn.dataset.active = 'true';
    micBtn.textContent = '🔴';
    micBtn.title = t('tts.listening');
    resultEl.className = 'pg-pronun-result pg-pronun-listening';
    resultEl.textContent = t('tts.listening');
    // ═ Handle stop click
    micBtn.onclick = (e) => {
        e.stopPropagation();
        recognition.abort();
    };
    recognition.onresult = (ev) => {
        if (!document.contains(resultEl))
            return;
        hasResult = true;
        // pick the highest-confidence candidate
        let bestText = '';
        let bestConf = -1;
        for (let i = 0; i < ev.results[0].length; i++) {
            const alt = ev.results[0][i];
            if (alt.confidence > bestConf) {
                bestConf = alt.confidence;
                bestText = alt.transcript;
            }
        }
        const score = _pronunciationScore(targetWord, bestText);
        _showPronunResult(resultEl, score, bestText.trim());
    };
    recognition.onerror = (ev) => {
        if (!document.contains(resultEl))
            return;
        if (hasResult)
            return;
        hasResult = true;
        if (ev.error === 'aborted' || ev.error === 'no-speech') {
            // aborted by the user or no speech detected — reset silently
            _resetMicBtn(micBtn);
            resultEl.className = 'pg-pronun-result';
            resultEl.textContent = '';
        }
        else if (ev.error === 'not-allowed') {
            resultEl.className = 'pg-pronun-result pg-pronun-error';
            resultEl.textContent = t('tts.noMic');
        }
        else {
            resultEl.className = 'pg-pronun-result pg-pronun-error';
            resultEl.textContent = t('tts.recogError', { err: ev.error });
        }
    };
    recognition.onend = () => {
        if (!document.contains(resultEl))
            return;
        // no result or error fired (e.g. no-speech timeout) — reset
        if (!hasResult) {
            resultEl.className = 'pg-pronun-result pg-pronun-error';
            resultEl.textContent = t('tts.noSpeech');
        }
        _resetMicBtn(micBtn);
    };
    recognition.start();
    // ═ Silent-fail guard — some browsers (iOS Safari, some Android) expose the
    // SpeechRecognition API but never fire onresult or onerror when the mic is
    // unavailable or the implementation is broken.  If nothing happens within
    // 10 seconds, abort and show a graceful error rather than hanging forever.
    const silentFailTimer = setTimeout(() => {
        if (hasResult)
            return;
        hasResult = true;
        recognition.abort();
        if (!document.contains(resultEl))
            return;
        resultEl.className = 'pg-pronun-result pg-pronun-error';
        resultEl.textContent = t('tts.noRecog');
        _resetMicBtn(micBtn);
    }, 10_000);
    // The existing onresult / onerror / onend handlers already gate on hasResult,
    // so setting hasResult = true in the timeout body is sufficient to prevent
    // them from running after the guard fires.  We only need to cancel the timer
    // when a real event arrives first.  We do this by wrapping recognition.onend,
    // which is guaranteed to fire after both onresult and onerror.
    const _prevOnEnd = recognition.onend;
    recognition.onend = (ev) => {
        clearTimeout(silentFailTimer);
        _prevOnEnd?.(ev);
    };
    return recognition;
}
/** Resets the mic button to its idle state. */
function _resetMicBtn(btn) {
    if (!btn)
        return;
    btn.dataset.active = 'false';
    btn.textContent = '🎤';
    btn.title = t('fl.mic');
}
/** Renders the pronunciation score and recognised text into resultEl. */
function _showPronunResult(resultEl, score, recognized) {
    const grade = score >= 85 ? 'excellent' :
        score >= 65 ? 'good' :
            score >= 40 ? 'fair' : 'poor';
    const label = score >= 85 ? t('tts.perfect') :
        score >= 65 ? t('tts.great') :
            score >= 40 ? t('tts.keep') : t('tts.tryAgain');
    resultEl.className = `pg-pronun-result pg-pronun-${grade}`;
    resultEl.innerHTML =
        `<span class="pg-pronun-score">${score}</span>` +
            `<span class="pg-pronun-label">${label}</span>` +
            `<span class="pg-pronun-heard">"${escapeHtml(recognized)}"</span>`;
}
/** Opens or updates the verb conjugation popup. */
// Module-level tracker so that re-opening the popup while one is already open
// correctly removes the previous ESC handler before adding a new one.
// ════════════════════════════
// AbortController + Snackbar
// ════════════════════════════
// References to tab content elements of the open panel
const _panelTabs = { wordbook: null, learn: null, settings: null };
// showAnnotateSnackbar, removeAnnotateSnackbar → see annotator.ts
// ════════════════════════════
// Learning Panel
// ════════════════════════════
// Programmatically activates a tab inside the open panel
function _activatePanelTab(panel, key) {
    const btn = panel.querySelector(`.pg-nav-tab[data-tab-id="${key}"]`);
    if (btn && !btn.classList.contains('active'))
        btn.click();
}
// Register openLearningPanel with annotator.ts so highlight clicks work
// (called here, after the function is defined)
function _registerAnnotatorPanel() { setOpenPanelFn(openLearningPanel); }
function openLearningPanel(initialTab = 'learn', wordData = null) {
    const existing = document.getElementById('pg-box-pg-learning-panel');
    // ═ Panel already open — update learn tab if needed
    if (existing) {
        if (wordData !== null) {
            // Push wordData into the learn tab's detail view
            if (_panelTabs.learn)
                _renderLearnDetail(_panelTabs.learn, wordData);
            // Switch to learn tab only if not mid-game
            const activeId = existing.querySelector('.pg-nav-tab.active')?.getAttribute('data-tab-id') ?? '';
            if (activeId !== 'learn' && initialTab === 'learn') {
                _activatePanelTab(existing, 'learn');
            }
        }
        else {
            _activatePanelTab(existing, initialTab);
        }
        return;
    }
    // ═ Build learn tab — detail card + mode buttons (state machine)
    function _buildLearnTab(container, initWordData) {
        container.className = 'pg-box-pane pg-learn-tab';
        // ── Detail card area (top, flex 1)
        const detailArea = document.createElement('div');
        detailArea.id = 'pg-learn-detail';
        detailArea.className = 'pg-learn-detail-area';
        renderDetailTab(detailArea, initWordData);
        container.appendChild(detailArea);
        // ── Mode area (fills when a mode is active)
        const modeArea = document.createElement('div');
        modeArea.id = 'pg-learn-mode';
        modeArea.className = 'pg-learn-mode-area';
        modeArea.style.display = 'none';
        container.appendChild(modeArea);
        // ── Bottom bar: mode selector buttons
        const bar = document.createElement('div');
        bar.className = 'pg-learn-bar';
        bar.innerHTML = `
            <button class="pg-learn-mode-btn" id="pg-lb-flash" title="${t('pnl.learn.flash')}">🃏</button>
            <button class="pg-learn-mode-btn" id="pg-lb-quiz"  title="${t('pnl.learn.quiz')}">🎯</button>
            <button class="pg-learn-mode-btn" id="pg-lb-match" title="${t('pnl.learn.match')}">🎮</button>
            <button class="pg-learn-mode-btn" id="pg-lb-speak" title="${t('pnl.learn.speak')}">🎤</button>`;
        container.appendChild(bar);
        const deps = {
            callModel, getContext, getSettings,
            saveSettings: saveSettingsDebounced,
            getLang, getNativeLang,
            askConfirm,
            // Wrap getAllConjEntries to pass the current language so stale
            // entries from a previously studied language are filtered out.
            getAllConjCache: (lang) => getAllConjEntries(lang),
        };
        function _enterMode(mode) {
            detailArea.style.display = 'none';
            modeArea.style.display = '';
            modeArea.innerHTML = '';
            // Back button
            const back = document.createElement('button');
            back.className = 'pg-learn-back-btn pg-btn pg-btn-secondary';
            back.textContent = t('pnl.learn.back');
            back.onclick = () => _exitMode();
            modeArea.appendChild(back);
            // Mode container
            const mc = document.createElement('div');
            mc.className = 'pg-learn-mode-inner';
            modeArea.appendChild(mc);
            // Mark active button
            bar.querySelectorAll('.pg-learn-mode-btn').forEach(b => b.classList.remove('active'));
            bar.querySelector(`#pg-lb-${mode}`)?.classList.add('active');
            if (mode === 'flash') {
                renderFlashcard(mc, _makeFlashDeps());
            }
            else if (mode === 'quiz') {
                mc.innerHTML = `
                    <div class="pg-quiz-modes">
                        <button class="pg-quiz-mode-btn" id="pg-qmode-quick">
                            <span class="pg-qmode-icon">⚡</span>
                            <span class="pg-qmode-title">${t('qz.modeQuick')}</span>
                            <span class="pg-qmode-desc">${t('qz.modeQuickDesc')}</span>
                        </button>
                        <button class="pg-quiz-mode-btn" id="pg-qmode-full">
                            <span class="pg-qmode-icon">📝</span>
                            <span class="pg-qmode-title">${t('qz.modeFull')}</span>
                            <span class="pg-qmode-desc">${t('qz.modeFullDesc')}</span>
                        </button>
                        <button class="pg-quiz-mode-btn" id="pg-qmode-cloze">
                            <span class="pg-qmode-icon">✏️</span>
                            <span class="pg-qmode-title">${t('qz.modeCloze')}</span>
                            <span class="pg-qmode-desc">${t('qz.modeClozeDesc')}</span>
                        </button>
                        <button class="pg-quiz-mode-btn" id="pg-qmode-exam">
                            <span class="pg-qmode-icon">🎓</span>
                            <span class="pg-qmode-title">${t('qz.modeExam')}</span>
                            <span class="pg-qmode-desc">${t('qz.modeExamDesc')}</span>
                        </button>
                        <button class="pg-quiz-mode-btn" id="pg-qmode-conj">
                            <span class="pg-qmode-icon">🔀</span>
                            <span class="pg-qmode-title">${t('qz.modeConj')}</span>
                            <span class="pg-qmode-desc">${t('qz.modeConjDesc')}</span>
                        </button>
                        <button class="pg-quiz-mode-btn" id="pg-qmode-targeted">
                            <span class="pg-qmode-icon">🎯</span>
                            <span class="pg-qmode-title">${t('qz.modeTargeted')}</span>
                            <span class="pg-qmode-desc">${t('qz.modeTargetedDesc')}</span>
                        </button>
                    </div>
                    <div id="pg-quiz-container" style="margin-top:10px;"></div>`;
                const qc = () => mc.querySelector('#pg-quiz-container');
                mc.querySelector('#pg-qmode-quick')?.addEventListener('click', () => { const c = qc(); if (c)
                    runMiniQuiz(c, deps, 3, 5); });
                mc.querySelector('#pg-qmode-full')?.addEventListener('click', () => { const c = qc(); if (c)
                    runMiniQuiz(c, deps, 6, 20); });
                mc.querySelector('#pg-qmode-cloze')?.addEventListener('click', () => { const c = qc(); if (c)
                    runClozeQuiz(c, deps); });
                mc.querySelector('#pg-qmode-exam')?.addEventListener('click', () => { const c = qc(); if (c)
                    runReadingExam(c, deps); });
                mc.querySelector('#pg-qmode-conj')?.addEventListener('click', () => { const c = qc(); if (c)
                    runConjDrill(c, deps); });
                mc.querySelector('#pg-qmode-targeted')?.addEventListener('click', () => { const c = qc(); if (c)
                    runTargetedExam(c, deps); });
            }
            else if (mode === 'speak') {
                renderSpeaking(mc, {
                    speak: speakWord,
                    getLang,
                    runPronunciationCheck,
                    hasSpeechRecognition: _hasSpeechRecognition,
                });
            }
            else {
                renderMatchSetup(mc);
            }
        }
        function _exitMode() {
            modeArea.style.display = 'none';
            modeArea.innerHTML = '';
            detailArea.style.display = '';
            bar.querySelectorAll('.pg-learn-mode-btn').forEach(b => b.classList.remove('active'));
        }
        bar.querySelector('#pg-lb-flash')?.addEventListener('click', () => _enterMode('flash'));
        bar.querySelector('#pg-lb-quiz')?.addEventListener('click', () => _enterMode('quiz'));
        bar.querySelector('#pg-lb-match')?.addEventListener('click', () => _enterMode('match'));
        bar.querySelector('#pg-lb-speak')?.addEventListener('click', () => _enterMode('speak'));
    }
    // Helper: update detail area if learn tab is open
    function _renderLearnDetail(learnContainer, wd) {
        const detailArea = learnContainer.querySelector('#pg-learn-detail');
        const modeArea = learnContainer.querySelector('#pg-learn-mode');
        if (detailArea)
            renderDetailTab(detailArea, wd);
        // If a mode is active, switch back to detail to show the new word
        if (modeArea && modeArea.style.display !== 'none') {
            modeArea.style.display = 'none';
            modeArea.innerHTML = '';
            if (detailArea)
                detailArea.style.display = '';
            learnContainer.querySelectorAll('.pg-learn-mode-btn').forEach(b => b.classList.remove('active'));
        }
    }
    // Expose for already-open panel path above
    openLearningPanel._renderLearnDetail = _renderLearnDetail;
    // ═ Build settings tab inside panel
    function _buildPanelSettingsTab(container) {
        container.className = 'pg-box-pane';
        const s = getSettings();
        container.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:16px;">

                <!-- Wordbook data management -->
                <div>
                    <div class="pg-pset-section-title">${t('tab.wordbook')}</div>
                    <div class="pg-pset-icon-row">
                        <button id="pg-pset-import" class="pg-pset-icon-btn" title="${t('pnl.set.import')}">
                            <i class="fa-solid fa-file-import"></i>
                            <span>${t('pnl.set.import')}</span>
                        </button>
                        <button id="pg-pset-csv" class="pg-pset-icon-btn" title="${t('pnl.set.export')}">
                            <i class="fa-solid fa-file-csv"></i>
                            <span>CSV</span>
                        </button>
                        <button id="pg-pset-txt" class="pg-pset-icon-btn" title="${t('pnl.set.exportTxt')}">
                            <i class="fa-solid fa-file-lines"></i>
                            <span>TXT</span>
                        </button>
                        <button id="pg-pset-pdf" class="pg-pset-icon-btn" title="${t('pnl.set.exportPdf')}">
                            <i class="fa-solid fa-file-pdf"></i>
                            <span>PDF</span>
                        </button>
                    </div>
                    <button id="pg-pset-reanalyse" class="pg-btn pg-btn-secondary" style="width:100%;margin-top:8px;" title="${t('wb.reanalyseTip')}">
                        ✨ ${t('wb.reanalyse')}
                    </button>
                    <div id="pg-pset-reanalysis-bar" class="pg-reanalysis-bar" style="display:none;margin-top:8px;"></div>
                </div>

                <!-- SRS reset -->
                <div>
                    <div class="pg-pset-section-title">${t('tab.learn')}</div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                        <label for="pg-pset-auto-idioms" style="font-size:13px;color:var(--pg-t2);">${t('pnl.set.autoIdioms')}</label>
                        <input type="checkbox" id="pg-pset-auto-idioms" ${s.auto_save_idioms !== false ? 'checked' : ''}
                            style="width:16px;height:16px;cursor:pointer;">
                    </div>
                    <button id="pg-pset-reset-srs" class="pg-btn pg-btn-secondary" style="width:100%;color:var(--pg-err);">
                        ${t('pnl.set.resetSrs')}
                    </button>
                    <button id="pg-pset-clear-conj" class="pg-btn pg-btn-secondary" style="width:100%;margin-top:8px;color:var(--pg-err);">
                        ${t('pnl.set.clearConj')}
                    </button>
                    <button id="pg-pset-clear-chat" class="pg-btn pg-btn-secondary" style="width:100%;margin-top:8px;color:var(--pg-err);">
                        ${t('pnl.set.clearChat')}
                    </button>
                    <div style="margin-top:12px;">
                        <div style="font-size:13px;color:var(--pg-t2);margin-bottom:4px;">${t('pnl.set.dictUrl')}</div>
                        <input type="text" id="pg-pset-dict-url" class="text_pole"
                            placeholder="${t('pnl.set.dictUrlPh')}"
                            value="${escapeHtml(s.dict_url_custom ?? '')}"
                            style="margin-bottom:4px;" autocomplete="off" spellcheck="false">
                        <div style="font-size:12px;color:var(--pg-t3);">${t('pnl.set.dictUrlDesc')}</div>
                    </div>
                </div>

                <!-- Panel appearance -->
                <div>
                    <div class="pg-pset-section-title">${t('set.panelSection')}</div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                        <label for="pg-pset-theme" style="font-size:13px;color:var(--pg-t2);">${t('pnl.set.theme')}</label>
                        <select id="pg-pset-theme" class="text_pole" style="width:120px;font-size:13px;">
                            <option value="dark"   ${(s.panel_theme ?? 'dark') === 'dark' ? 'selected' : ''}>${t('set.themeDark')}</option>
                            <option value="light"  ${(s.panel_theme ?? 'dark') === 'light' ? 'selected' : ''}>${t('set.themeLight')}</option>
                            <option value="breeze" ${(s.panel_theme ?? 'dark') === 'breeze' ? 'selected' : ''}>${t('set.themeBreeze')}</option>
                            <option value="milk"   ${(s.panel_theme ?? 'dark') === 'milk' ? 'selected' : ''}>${t('set.themeMilk')}</option>
                        </select>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                        <label for="pg-pset-floating" style="font-size:13px;color:var(--pg-t2);">${t('pnl.set.floating')}</label>
                        <input type="checkbox" id="pg-pset-floating" ${s.panel_floating ? 'checked' : ''}
                            style="width:16px;height:16px;cursor:pointer;">
                    </div>
                    <div style="font-size:13px;color:var(--pg-t2);margin-bottom:4px;">${t('pnl.set.bgUrl')}</div>
                    <input type="text" id="pg-pset-bg-url" class="text_pole"
                        placeholder="${t('pnl.set.bgUrlPh')}"
                        value="${escapeHtml(s.panel_bg_image ?? '')}"
                        style="margin-bottom:4px;" autocomplete="off" spellcheck="false">
                </div>
            </div>`;
        const wb = () => loadWordbook();
        container.querySelector('#pg-pset-import')?.addEventListener('click', () => {
            triggerImport(_panelTabs.wordbook ?? container);
        });
        container.querySelector('#pg-pset-csv')?.addEventListener('click', () => {
            exportToCSV(wb());
        });
        container.querySelector('#pg-pset-txt')?.addEventListener('click', () => {
            exportToFlashcardTxt(wb());
        });
        container.querySelector('#pg-pset-pdf')?.addEventListener('click', async () => {
            const wordbook = wb();
            if (!wordbook.length) {
                notify(t('wb.noExport'), 'warn');
                return;
            }
            const btn = container.querySelector('#pg-pset-pdf');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            }
            try {
                const conjEntries = await getAllConjEntries(getLang());
                exportToPDF(wordbook, conjEntries);
            }
            finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-file-pdf"></i><span>PDF</span>';
                }
            }
        });
        // Full reanalysis — wired to the settings tab's own progress bar
        container.querySelector('#pg-pset-reanalyse')?.addEventListener('click', () => {
            if (isReanalysisRunning()) {
                abortReanalysis();
                return;
            }
            const reBtn = container.querySelector('#pg-pset-reanalyse');
            const bar = container.querySelector('#pg-pset-reanalysis-bar');
            if (!reBtn || !bar)
                return;
            const wordbook = loadWordbook();
            const pool = wordbook.filter(e => e.level !== 'grammar' && e.level !== 'sentence');
            if (!pool.length) {
                notify(t('wb.reanalyseNone'), 'warn');
                return;
            }
            reBtn.textContent = t('wb.reanalysing');
            bar.style.display = '';
            bar.innerHTML = `<div class="pg-reanalysis-progress">
                <span class="pg-reanalysis-text">${t('wb.reanalyseProgress', { done: 0, total: pool.length })}</span>
                <button class="pg-reanalysis-stop" id="pg-pset-reanalyse-stop">${t('ann.stop')}</button>
            </div>
            <div class="pg-reanalysis-track"><div class="pg-reanalysis-fill" style="width:0%"></div></div>`;
            bar.querySelector('#pg-pset-reanalyse-stop')?.addEventListener('click', () => abortReanalysis());
            runReanalysis({ callModel, getLang, getNativeLang }, {
                onProgress(done, total, word) {
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    const text = bar.querySelector('.pg-reanalysis-text');
                    const fill = bar.querySelector('.pg-reanalysis-fill');
                    if (text)
                        text.textContent = t('wb.reanalyseProgress', { done, total, word });
                    if (fill)
                        fill.style.width = `${pct}%`;
                },
                onDone(processed, total, aborted) {
                    bar.style.display = 'none';
                    reBtn.textContent = `✨ ${t('wb.reanalyse')}`;
                    const msg = aborted
                        ? t('wb.reanalyseStopped', { done: processed, total })
                        : t('wb.reanalyseDone', { n: processed });
                    notify(msg, aborted ? 'warn' : 'ok', 3000);
                    if (_panelTabs.wordbook)
                        renderWordbook(_panelTabs.wordbook);
                },
            });
        });
        container.querySelector('#pg-pset-auto-idioms')?.addEventListener('change', e => {
            getSettings().auto_save_idioms = e.target.checked;
            saveSettingsDebounced();
        });
        container.querySelector('#pg-pset-reset-srs')?.addEventListener('click', async () => {
            const ok = await askConfirm(t('pnl.set.resetSrsConfirm'));
            if (!ok)
                return;
            const wordbook = wb();
            wordbook.forEach(w => {
                w.srs_interval = 1;
                w.srs_ease = 2.5;
                w.srs_due = 0;
                w.srs_streak = 0;
                w.srs_reviewed_at = undefined;
            });
            saveWordbook(wordbook);
            notify(t('pnl.set.resetSrs') + ' ✓');
        });
        container.querySelector('#pg-pset-clear-conj')?.addEventListener('click', async () => {
            const ok = await askConfirm(t('pnl.set.clearConjConfirm'));
            if (!ok)
                return;
            await clearAllConjCache();
            notify(t('pnl.set.clearConj') + ' ✓');
        });
        container.querySelector('#pg-pset-clear-chat')?.addEventListener('click', async () => {
            const ok = await askConfirm(t('pnl.set.clearChatConfirm'));
            if (!ok)
                return;
            clearCurrentChatAnnotations();
            notify(t('pnl.set.clearChat') + ' ✓');
        });
        container.querySelector('#pg-pset-dict-url')?.addEventListener('input', e => {
            getSettings().dict_url_custom = e.target.value;
            saveSettingsDebounced();
        });
        container.querySelector('#pg-pset-theme')?.addEventListener('change', e => {
            const val = e.target.value;
            getSettings().panel_theme = val;
            saveSettingsDebounced();
            _applyPanelTheme();
        });
        container.querySelector('#pg-pset-floating')?.addEventListener('change', e => {
            const on = e.target.checked;
            getSettings().panel_floating = on;
            saveSettingsDebounced();
            const sidebar = (document.getElementById('pg-box-pg-learning-panel') ??
                document.querySelector('.pg-sidebar'));
            if (!sidebar)
                return;
            if (on)
                _enterFloating(sidebar);
            else
                _exitFloating(sidebar);
        });
        container.querySelector('#pg-pset-bg-url')?.addEventListener('input', e => {
            const url = e.target.value.trim();
            getSettings().panel_bg_image = url || '';
            saveSettingsDebounced();
            _applyPanelTheme();
        });
    }
    // ═ Create panel with 3 tabs
    const panes = [
        {
            name: t('tab.wordbook'), id: 'wordbook',
            render: () => {
                _panelTabs.wordbook = document.createElement('div');
                _panelTabs.wordbook.className = 'pg-box-pane';
                renderWordbook(_panelTabs.wordbook);
                return _panelTabs.wordbook;
            },
        },
        {
            name: t('tab.learn'), id: 'learn',
            render: () => {
                _panelTabs.learn = document.createElement('div');
                _buildLearnTab(_panelTabs.learn, wordData);
                return _panelTabs.learn;
            },
        },
        {
            name: t('tab.settings'), id: 'settings',
            render: () => {
                _panelTabs.settings = document.createElement('div');
                _buildPanelSettingsTab(_panelTabs.settings);
                return _panelTabs.settings;
            },
        },
    ];
    const defaultTab = wordData ? 'learn' : initialTab;
    openPanel(buildTabView(panes, defaultTab), {
        panelId: 'pg-learning-panel',
        extra: 'pg-sidebar',
        onDismiss: () => {
            if (_activeRecognition) {
                _activeRecognition.abort();
                _activeRecognition = null;
            }
            _panelTabs.wordbook = _panelTabs.learn = _panelTabs.settings = null;
        },
    });
    // ═ Apply theme + bg image + floating state
    _applyPanelTheme();
    requestAnimationFrame(_applyPanelTheme);
    setTimeout(_applyPanelTheme, 80);
    // ═ Apply saved floating state (desktop/tablet only)
    if (!window.matchMedia('(pointer: coarse) and (max-width: 600px)').matches) {
        requestAnimationFrame(() => {
            const sidebar = (document.getElementById('pg-box-pg-learning-panel') ??
                document.querySelector('.pg-sidebar'));
            if (sidebar && getSettings().panel_floating)
                _enterFloating(sidebar);
        });
    }
}
/** Reads current settings and applies panel_theme + panel_bg_image to the open sidebar. */
function _applyPanelTheme() {
    // The panel box element itself carries the pg-sidebar class (added via extra: 'pg-sidebar')
    // so we target it directly, not as a descendant.
    const sidebar = (document.getElementById('pg-box-pg-learning-panel') ??
        document.querySelector('#pg-box-pg-learning-panel.pg-sidebar') ??
        document.querySelector('.pg-sidebar'));
    if (!sidebar)
        return;
    const s = getSettings();
    if (s.panel_theme && s.panel_theme !== 'dark') {
        sidebar.setAttribute('data-pg-theme', s.panel_theme);
    }
    else {
        sidebar.removeAttribute('data-pg-theme');
    }
    const url = s.panel_bg_image;
    // Sanitise URL: strip embedded quotes to prevent CSS injection via url("...")
    const safeUrl = url ? url.replace(/"/g, '%22') : '';
    if (safeUrl) {
        sidebar.style.setProperty('--pg-panel-bg-image', `url("${safeUrl}")`);
        sidebar.setAttribute('data-has-bg', ''); // drives [data-has-bg] liquid glass CSS
    }
    else {
        sidebar.style.removeProperty('--pg-panel-bg-image');
        sidebar.removeAttribute('data-has-bg');
    }
}
/** Switch sidebar into free-floating draggable mode. */
function _enterFloating(sidebar) {
    if (sidebar.classList.contains('pg-sidebar-floating'))
        return;
    sidebar.classList.add('pg-sidebar-floating');
    const r = sidebar.getBoundingClientRect();
    sidebar.style.setProperty('right', 'auto', 'important');
    sidebar.style.setProperty('bottom', 'auto', 'important');
    sidebar.style.setProperty('top', `${r.top}px`, 'important');
    sidebar.style.setProperty('left', `${r.left}px`, 'important');
    _wireDrag(sidebar);
}
/** Switch sidebar back to anchored mode. */
function _exitFloating(sidebar) {
    sidebar.classList.remove('pg-sidebar-floating');
    sidebar.style.removeProperty('top');
    sidebar.style.removeProperty('left');
    sidebar.style.removeProperty('right');
    sidebar.style.removeProperty('bottom');
}
/** Wire pointer-drag on the title bar of the floating panel. Idempotent. */
function _wireDrag(sidebar) {
    if (sidebar._pgDragWired)
        return;
    sidebar._pgDragWired = true;
    let dragging = false;
    let ox = 0, oy = 0;
    // Use sidebar as drag handle — interactive children and content panes
    // still receive their own click/scroll events normally.
    // (.pg-box-title may or may not exist depending on ST version)
    const handle = (sidebar.querySelector('.pg-box-title') ?? sidebar);
    handle.addEventListener('pointerdown', e => {
        if (!sidebar.classList.contains('pg-sidebar-floating'))
            return;
        const t = e.target;
        // Let buttons, inputs, links handle their own events
        if (t.closest('button, input, select, a'))
            return;
        // If handle is the full sidebar, skip drags originating in content panes
        if (handle === sidebar && t.closest('.pg-nav-view, .pg-box-pane'))
            return;
        dragging = true;
        const r = sidebar.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        sidebar.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    sidebar.addEventListener('pointermove', e => {
        if (!dragging)
            return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = sidebar.offsetWidth;
        const h = sidebar.offsetHeight;
        const nx = Math.max(0, Math.min(e.clientX - ox, vw - w));
        const ny = Math.max(0, Math.min(e.clientY - oy, vh - h));
        sidebar.style.setProperty('left', `${nx}px`, 'important');
        sidebar.style.setProperty('top', `${ny}px`, 'important');
    });
    sidebar.addEventListener('pointerup', () => { dragging = false; });
    sidebar.addEventListener('pointercancel', () => { dragging = false; });
}
// renderDetailTab → ui/wordbook-ui.ts
// addToWordbook   → ui/wordbook-ui.ts
// ════════════════════════════
// Flashcard
// ════════════════════════════
// Module-level ref so onDismiss (panel close) can abort an in-progress mic session.
let _activeRecognition = null;
/** FlashDeps bridge — injects index.ts-level helpers into the flashcard module. */
function _makeFlashDeps() {
    return {
        callModel,
        getLang,
        getNativeLang,
        getSettings,
        speak: speakWord,
        hasSpeechRecog: _hasSpeechRecognition,
        runPronunCheck: runPronunciationCheck,
        setActiveRecog: (r) => { _activeRecognition = r; },
        getActiveRecog: () => _activeRecognition,
    };
}
// ════════════════════════════
// Feature B: Message Annotator
// ════════════════════════════
// annotatedMsgs/annotationCache/mesObservers/annotateAborts + annotator functions → see annotator.ts
// ════════════════════════════
// Feature C: Selection Quick Lookup
// ════════════════════════════
// ════════════════════════════
// Input Toolbar Button
// ════════════════════════════
function injectWandButton() {
    if (!getSettings().enabled_checker)
        return; // hidden when checker is disabled
    if (document.getElementById('pg-wand-btn'))
        return;
    const sendBtn = document.getElementById('send_but');
    if (!sendBtn?.parentNode)
        return;
    const btn = document.createElement('div');
    btn.id = 'pg-wand-btn';
    btn.className = 'pg-wand-btn interactable';
    btn.title = t('chk.btnTitle');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = '<i class="fa-solid fa-earth-europe"></i>';
    btn.addEventListener('click', () => runChecker({ callModel, getSettings, getLang, getNativeLang, setWandBusy }));
    sendBtn.parentNode.insertBefore(btn, sendBtn);
}
function setWandBusy(busy) {
    const btn = document.getElementById('pg-wand-btn');
    if (!btn)
        return;
    btn.innerHTML = busy ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '<i class="fa-solid fa-earth-europe"></i>';
    btn.style.pointerEvents = busy ? 'none' : '';
    btn.style.opacity = busy ? '0.6' : '';
}
/** Adds a Polyglot entry to the ST Extensions menu (🧩 dropdown left of the input bar). */
function injectExtensionsMenuEntry() {
    if (document.getElementById('pg-ext-menu-btn'))
        return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu)
        return;
    const item = document.createElement('div');
    item.id = 'pg-ext-menu-btn';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.title = t('ext.panelTitle');
    item.innerHTML =
        '<div class="fa-solid fa-earth-europe extensionsMenuExtensionButton"></div>' +
            `<span>${t('ext.menuLabel')}</span>`;
    item.addEventListener('click', () => {
        $('#extensionsMenu').hide(); // ST manages this menu via jQuery
        openLearningPanel();
    });
    menu.appendChild(item);
}
// ════════════════════════════
// Settings Panel
// ════════════════════════════
// ════════════════════════════
// Initialisation
// ════════════════════════════
(function init() {
    // eventSource and event_types are imported directly from ST's script.js
    _registerAnnotatorPanel(); // inject openLearningPanel into annotator.ts
    initTapTranslate({
        callModel,
        getLang,
        getNativeLang,
        getSettings,
        addToWordbook,
        openLearningPanel,
    });
    initWbUI({
        callModel,
        getLang,
        getNativeLang,
        speak: speakWord,
        getSettings,
        getWbContainer: () => _panelTabs.wordbook,
    });
    initSettingsUI({
        getSettings,
        save,
        clearAllConjCache,
    });
    buildSettingsPanel();
    eventSource.on(event_types.APP_READY, () => {
        pruneOrphanSets(); // clean up sets left by previous import bugs — safe only after full data load
        injectWandButton();
        injectAnnotateButtons();
        injectExtensionsMenuEntry();
        setupTextSelectionTooltip();
        setupTapToTranslate();
        restoreWithRetry();
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        injectAnnotateButtons();
        restoreAnnotations();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // Abort all in-progress annotation requests to prevent race conditions on chat switch
        annotateAborts.forEach((ctrl) => ctrl.abort());
        annotateAborts.clear();
        // Abort in-progress quick lookup
        abortQuickLookup();
        // Abort in-progress tap-to-translate requests and remove any open bubbles
        abortAllTapTranslate();
        removeTapBubbles();
        // Clear state immediately so CHARACTER_MESSAGE_RENDERED (which may fire before
        // the 300 ms delay elapses) cannot add entries that we then wipe out later.
        annotatedMsgs.clear();
        annotationCache.clear();
        mesObservers.forEach(e => { e.cancel(); });
        mesObservers.clear();
        // Defer inject + restore until ST has finished rendering the new chat's DOM.
        setTimeout(() => {
            injectWandButton();
            injectAnnotateButtons();
            restoreAnnotations();
        }, DELAY.chatSwitch);
    });
    // ═ MESSAGE_SWIPED: clean up annotation state and abort requests for swiped messages
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
        const mesId = String(messageId);
        // Abort the in-progress request (prevents zombie fetches and wasted API tokens)
        annotateAborts.get(mesId)?.abort();
        annotateAborts.delete(mesId);
        // Cancel observer and clean up state
        const entry = mesObservers.get(mesId);
        if (entry) {
            entry.cancel();
            mesObservers.delete(mesId);
        }
        annotatedMsgs.delete(mesId);
        annotationCache.delete(mesId);
        unpersistAnnotation(mesId);
        // Remove any remaining highlight spans directly
        const textEl = document.querySelector(`.mes[mesid="${CSS.escape(mesId)}"] .mes_text`);
        if (textEl)
            stripHighlightsFromEl(textEl);
        document.querySelector(`.mes[mesid="${CSS.escape(mesId)}"] .pg-annotate-btn`)
            ?.classList.remove('pg-btn-active', 'pg-btn-busy');
    });
    injectWandButton();
    injectAnnotateButtons();
    injectExtensionsMenuEntry();
    // (wordbook context-popover outside-click handler is registered in initWbUI)
    // ─ React to enabled_checker / enabled_annotator toggles in the settings UI
    document.addEventListener('pg:checker-toggle', (e) => {
        const on = e.detail.on;
        if (on) {
            injectWandButton();
        }
        else {
            document.getElementById('pg-wand-btn')?.remove();
        }
    });
    document.addEventListener('pg:annotator-toggle', (e) => {
        const on = e.detail.on;
        if (on) {
            injectAnnotateButtons();
        }
        else {
            document.querySelectorAll('.pg-annotate-btn, .pg-open-btn').forEach(b => b.remove());
        }
    });
})();
// ════════════════════════════
// Slash Commands
// ════════════════════════════
// ═ /pg-check
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'pg-check',
    callback: async () => {
        await runChecker({ callModel, getSettings, getLang, getNativeLang, setWandBusy });
        return 'Done.';
    },
    helpString: 'Polyglot: check and translate the current input box content (same as the 🌍 button).',
}));
// ═ /pg-annotate
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'pg-annotate',
    callback: async (args) => {
        const ctx = getContext();
        const mesId = args.mesid
            ? String(args.mesid)
            : String((ctx.chat?.length ?? 1) - 1);
        const msgEl = document.querySelector(`.mes[mesid="${CSS.escape(mesId)}"]`);
        if (!msgEl)
            return `Message ID ${mesId} not found.`;
        await runAnnotator(msgEl, mesId);
        return `Message #${mesId} annotated.`;
    },
    helpString: 'Polyglot: annotate a message for study. Omit mesid to annotate the last message.',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'mesid',
            description: 'ID of the message to annotate (defaults to the last message)',
            typeList: [ARGUMENT_TYPE.NUMBER],
            isRequired: false,
            defaultValue: '{{lastMessageId}}',
        }),
    ],
}));
// ═ /pg-lookup
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'pg-lookup',
    callback: async (args, value) => {
        const word = value?.trim();
        if (!word)
            return 'Please provide a word. Example: /pg-lookup hablar';
        await runQuickLookup(word, '');
        return `"${word}" looked up.`;
    },
    helpString: 'Polyglot: look up a word and open the learning panel. Example: /pg-lookup hablar',
    unnamedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'word',
            description: 'Word or phrase to look up',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
        }),
    ],
}));
// ═ /pg-panel
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'pg-panel',
    callback: async (args) => {
        const tab = args.tab || 'learn';
        const validTabs = ['wordbook', 'learn', 'settings'];
        openLearningPanel(validTabs.includes(tab) ? tab : 'learn');
        return 'Learning panel opened.';
    },
    helpString: 'Polyglot: open the learning panel. tab: detail | wordbook | quiz | match | flash',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'tab',
            description: 'Tab to open (wordbook | learn | settings)',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
            defaultValue: 'learn',
        }),
    ],
}));
