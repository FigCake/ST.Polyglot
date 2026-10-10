// ════════════════════════════
// Polyglot  ui/learning-panel.ts
// ════════════════════════════
// The learning side panel: Wordbook · Learn · Settings tabs.
//
// Tabs are built lazily on first visit (buildTabView). The Learn tab is kept
// while the panel is open so a new lookup can be shown in it.
//
// Word lookups live here too: they always end in this panel's detail card.
//
// Dependencies: ui.manager.ts, speech.ts, prompts.ts, runtime.ts, ai/client.ts,
//               ui/wordbook-ui.ts, ui/panel/*
import { openPanel, buildTabView } from '../ui.manager.js';
import { abortActiveRecognition } from '../speech.js';
import { t } from '../i18n.js';
import { quickLookupPrompt } from '../prompts.js';
import { ai, getLang, getNativeLang, getSettings } from '../runtime.js';
import { acceptObject } from '../ai/client.js';
import { renderWordbook, unmountWordbook, addToWordbook } from './wordbook-ui.js';
import { LearnTab } from './panel/learn-tab.js';
import { buildSettingsTab } from './panel/settings-tab.js';
import { PANEL_ID, PANEL_BOX_ID, restorePanelChrome } from './panel/chrome.js';
export const PANEL_TABS = ['wordbook', 'learn', 'settings'];
let learnTab = null;
function activateTab(panel, tab) {
    const btn = panel.querySelector(`.pg-nav-tab[data-tab-id="${tab}"]`);
    if (btn && !btn.classList.contains('active'))
        btn.click();
}
/**
 * Opens the panel on `initialTab`, or — if it is already open — switches tab.
 * Passing `wordData` shows that word in the Learn tab's detail card.
 */
export function openLearningPanel(initialTab = 'learn', wordData = null) {
    const existing = document.getElementById(PANEL_BOX_ID);
    if (existing) {
        if (!wordData) {
            activateTab(existing, initialTab);
            return;
        }
        learnTab?.showDetail(wordData);
        if (initialTab === 'learn')
            activateTab(existing, 'learn');
        return;
    }
    const tabs = buildTabView([
        {
            name: t('tab.wordbook'), id: 'wordbook',
            render: () => {
                const el = Object.assign(document.createElement('div'), { className: 'pg-box-pane' });
                renderWordbook(el);
                return el;
            },
        },
        {
            name: t('tab.learn'), id: 'learn',
            render: () => (learnTab = new LearnTab(wordData, { lookup: w => lookUpWord(w), save: addToWordbook })).el,
        },
        {
            name: t('tab.settings'), id: 'settings',
            render: buildSettingsTab,
        },
    ], wordData ? 'learn' : initialTab);
    openPanel(tabs, {
        panelId: PANEL_ID,
        extra: 'pg-sidebar',
        onDismiss: () => {
            abortActiveRecognition();
            unmountWordbook();
            learnTab = null;
        },
    });
    restorePanelChrome();
}
// ── Word lookup ───────────────────────────────────────────────────────────────
let lookupRequest = null;
/** Looks a word up (with its sentence as context for the meaning) and shows it in the Learn tab. */
export async function lookUpWord(word, context = '') {
    lookupRequest?.abort();
    const request = new AbortController();
    lookupRequest = request;
    openLearningPanel('learn', { type: 'loading', word });
    try {
        const { data } = await ai.json({
            prompt: quickLookupPrompt(word, context, getLang(), getSettings().cefr_level, getNativeLang()),
            signal: request.signal,
            accept: (acceptObject),
        });
        if (!request.signal.aborted)
            openLearningPanel('learn', { type: 'word', data: { ...data, level: data.level || 'B1' } });
    }
    catch (e) {
        if (!request.signal.aborted)
            openLearningPanel('learn', { type: 'error', word, message: e instanceof Error ? e.message : String(e) });
    }
    finally {
        if (lookupRequest === request)
            lookupRequest = null;
    }
}
export function cancelLookup() {
    lookupRequest?.abort();
    lookupRequest = null;
}
