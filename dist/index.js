// Entry point: wires modules together, injects chat-UI buttons, subscribes to
// ST events and registers slash commands. Feature logic lives elsewhere:
//
//   runtime.ts            settings + settings-bound helpers (ai client, getLang…)
//   st.ts                 SillyTavern's runtime, typed (the only module that imports it)
//   data-store.ts         the learner's data (wordbook, sets, wrong answers, corrections, study days)
//                         in a server file; save-journal.ts keeps unsaved changes in the browser
//   voice.ts              reading aloud (speech.ts plays, tts.ts calls voice services)
//   ui/learning-panel.ts  the side panel and word lookup (ui/panel/* for tabs and chrome)
//   ai/client.ts          every AI request: JSON repair, one strict retry, partial results
//   export/pdf.ts         printable flashcard deck
import { setupTapToTranslate, removeTapBubbles, abortAllTapTranslate } from './ui/tap-translate.js';
import { buildSettingsPanel } from './ui/settings-ui.js';
import { openLearningPanel, lookUpWord, cancelLookup, PANEL_TABS } from './ui/learning-panel.js';
import { getSettings, getLang, getNativeLang, ai, getContext } from './runtime.js';
import { DELAY } from './constants.js';
import { ST_SEL, mesSelector } from './st-dom.js';
import { runChecker } from './features/checker.js';
import { migrateChatWordbook, studyLangKey } from './wordbook.js';
import { archiveCheck } from './check-archive.js';
import { refreshWordbook } from './ui/wordbook-ui.js';
import { initDataStore, onDataReplaced, onDataChanged, storeMode } from './data-store.js';
import { refreshSavedMarks, clearSavedMarks, resetSavedMarks, savedWordsChanged, countEncounters, resetEncounters, setSavedMarksPanelFn, } from './saved-marks.js';
import { notify } from './ui.manager.js';
import { setOpenPanelFn, injectAnnotateButtons, runAnnotator, isAnnotated, restoreAnnotations, restoreWithRetry, resetChatState, forgetMessage, redrawAnnotations, relocateAnnotations, } from './annotator.js';
import { t } from './i18n.js';
import { setupPlainCopy } from './plain-text.js';
import { restoreFurigana, restoreFuriganaWithRetry, autoFurigana, relocateFurigana, forgetFurigana, resetFuriganaState, applyFuriganaDisplay, onFuriganaSettingChange, setupReadingEditor, } from './furigana/messages.js';
import { eventSource, event_types, SlashCommandParser, SlashCommand, ARGUMENT_TYPE, SlashCommandNamedArgument } from './st.js';
// ── Chat-UI entry points ──────────────────────────────────────────────────────
const WAND_ICON = '<i class="fa-solid fa-earth-europe"></i>';
const SPINNER_ICON = '<i class="fa-solid fa-spinner fa-spin"></i>';
const checkerDeps = () => ({ ai, getSettings, getLang, getNativeLang, setWandBusy, archive: archiveCheck, langKey: studyLangKey });
/** Adds the 🌍 input-assistant button next to ST's send button. */
function injectWandButton() {
    if (!getSettings().enabled_checker)
        return;
    if (document.getElementById('pg-wand-btn'))
        return;
    const sendBtn = document.querySelector(ST_SEL.sendBtn);
    if (!sendBtn?.parentNode)
        return;
    const btn = Object.assign(document.createElement('div'), {
        id: 'pg-wand-btn', className: 'pg-wand-btn interactable', title: t('chk.btnTitle'), tabIndex: 0,
        innerHTML: WAND_ICON,
    });
    btn.addEventListener('click', () => runChecker(checkerDeps()));
    sendBtn.parentNode.insertBefore(btn, sendBtn);
}
function setWandBusy(busy) {
    const btn = document.getElementById('pg-wand-btn');
    if (!btn)
        return;
    btn.innerHTML = busy ? SPINNER_ICON : WAND_ICON;
    btn.classList.toggle('pg-wand-busy', busy);
    btn.setAttribute('aria-busy', String(busy));
}
/** Adds a Polyglot entry to the ST Extensions menu (🧩 dropdown left of the input bar). */
function injectExtensionsMenuEntry() {
    if (document.getElementById('pg-ext-menu-btn'))
        return;
    const menu = document.querySelector(ST_SEL.extensionsMenu);
    if (!menu)
        return;
    const item = Object.assign(document.createElement('div'), {
        id: 'pg-ext-menu-btn', className: 'list-group-item flex-container flexGap5 interactable',
        title: t('ext.panelTitle'),
    });
    const icon = Object.assign(document.createElement('div'), { className: 'fa-solid fa-earth-europe extensionsMenuExtensionButton' });
    const label = Object.assign(document.createElement('span'), { textContent: t('ext.menuLabel') });
    item.append(icon, label);
    item.addEventListener('click', () => {
        $(ST_SEL.extensionsMenu).hide(); // ST manages this menu via jQuery
        openLearningPanel();
    });
    menu.appendChild(item);
}
function injectChatButtons() {
    injectWandButton();
    injectAnnotateButtons();
}
// ── Chat lifecycle ────────────────────────────────────────────────────────────
/** Moves an old per-chat wordbook into the shared one (once per chat), then shows the open chat's words. */
async function adoptChatWordbook() {
    refreshWordbook();
    const moved = await migrateChatWordbook();
    if (!moved)
        return;
    notify(t('wb.migrated', { n: moved }), 'info', 4000);
    refreshWordbook();
}
/** Cancels in-flight work and clears per-chat state when the user switches chat. */
function onChatChanged() {
    resetChatState();
    resetFuriganaState();
    resetSavedMarks();
    resetEncounters();
    cancelLookup();
    abortAllTapTranslate();
    removeTapBubbles();
    // Wait for ST to finish rendering the new chat's DOM.
    setTimeout(() => {
        injectChatButtons();
        restoreAnnotations();
        restoreFuriganaWithRetry();
        refreshSavedMarks();
        void adoptChatWordbook();
    }, DELAY.chatSwitch);
}
/** Subscribes to a `pg:*-toggle` event dispatched by the settings UI. */
function onToggle(name, handler) {
    document.addEventListener(name, e => handler(e.detail.on));
}
// ── Initialisation ────────────────────────────────────────────────────────────
(function init() {
    setOpenPanelFn(openLearningPanel); // highlight clicks in annotator.ts open the panel
    setSavedMarksPanelFn(openLearningPanel);
    // A word saved, reviewed or edited: the underlines follow (a moment later, once per run of changes)
    onDataChanged(() => { savedWordsChanged(); refreshSavedMarks(); });
    buildSettingsPanel();
    onDataReplaced(refreshWordbook);
    eventSource.on(event_types.APP_READY, () => {
        // Words are readable at once (from memory); the file load merges them in
        void initDataStore().then(() => {
            savedWordsChanged();
            refreshSavedMarks();
            // ST may still be drawing the chat: once more when it is likely done
            setTimeout(() => refreshSavedMarks(), DELAY.chatSwitch * 3);
            if (storeMode() !== 'file')
                return;
            void adoptChatWordbook();
        });
        injectChatButtons();
        injectExtensionsMenuEntry();
        setupTapToTranslate();
        setupPlainCopy();
        setupReadingEditor();
        applyFuriganaDisplay();
        restoreWithRetry();
        restoreFuriganaWithRetry();
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        injectAnnotateButtons();
        restoreAnnotations();
        restoreFurigana();
        if (mesId !== undefined) {
            autoFurigana(String(mesId));
            refreshSavedMarks([String(mesId)]);
            countEncounters(String(mesId));
        }
    });
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_SWIPED, (id) => {
        forgetMessage(String(id));
        forgetFurigana(String(id));
        // Back to a swipe that was analysed: ST has already drawn its text, so its analysis shows again
        restoreAnnotations();
        restoreFurigana();
        refreshSavedMarks([String(id)]);
    });
    // An edited or deleted message: highlights whose text no longer matches go
    if (event_types.MESSAGE_UPDATED)
        eventSource.on(event_types.MESSAGE_UPDATED, () => { restoreAnnotations(); restoreFurigana(); refreshSavedMarks(); });
    // After a deletion ST renumbers the later messages: their saved analyses move along
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            relocateAnnotations();
            relocateFurigana();
            restoreAnnotations();
            restoreFurigana();
            refreshSavedMarks();
        });
    }
    // Older messages loaded with "Show more messages" get buttons and their saved highlights
    if (event_types.MORE_MESSAGES_LOADED) {
        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
            injectAnnotateButtons();
            // Older messages renumbered by a deletion while they were not rendered find their saves again
            relocateAnnotations();
            relocateFurigana();
            restoreAnnotations();
            restoreFurigana();
            refreshSavedMarks();
        });
    }
    injectChatButtons();
    injectExtensionsMenuEntry();
    onToggle('pg:checker-toggle', on => {
        if (on)
            injectWandButton();
        else
            document.getElementById('pg-wand-btn')?.remove();
    });
    document.addEventListener('pg:language-change', onFuriganaSettingChange);
    // Lists may be limited to the study language
    document.addEventListener('pg:language-change', refreshWordbook);
    document.addEventListener('pg:study-scope-change', () => { redrawAnnotations(); refreshSavedMarks(); });
    onToggle('pg:saved-marks-toggle', on => (on ? refreshSavedMarks() : clearSavedMarks()));
    onToggle('pg:annotator-toggle', on => {
        if (on)
            injectAnnotateButtons();
        else
            document.querySelectorAll('.pg-annotate-btn, .pg-open-btn').forEach(b => b.remove());
    });
})();
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'pg-check',
    callback: async (_args, value) => {
        if (!getSettings().enabled_checker) {
            notify(t('chk.slashOff'), 'warn', 4000);
            return 'The input assistant is turned off.';
        }
        const textarea = document.querySelector(ST_SEL.sendTextarea);
        // Typed in the input box, the command has replaced what was there: the text comes with it
        const text = value?.trim();
        if (text && textarea) {
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (!textarea?.value.trim()) {
            notify(t('chk.slashEmpty'), 'info', 4000);
            return 'Nothing to check.';
        }
        await runChecker(checkerDeps());
        return 'Done.';
    },
    helpString: 'Polyglot: check and translate a text (same as the 🌍 button), put back in the input box. Example: /pg-check Ciao, come stai? Without text it checks what is in the input box (for Quick Replies and scripts).',
    unnamedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'text',
            description: 'Text to check (defaults to the input box)',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        }),
    ],
}));
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'pg-annotate',
    callback: async (args) => {
        const ctx = getContext();
        const mesId = args.mesid
            ? String(args.mesid)
            : String((ctx.chat?.length ?? 1) - 1);
        const msgEl = document.querySelector(mesSelector(mesId));
        if (!msgEl)
            return `Message ID ${mesId} not found.`;
        // The 📖 button toggles; the command only adds (a script running it must not delete an analysis)
        if (isAnnotated(mesId))
            return `Message #${mesId} is already annotated.`;
        await runAnnotator(msgEl, mesId);
        return isAnnotated(mesId) ? `Message #${mesId} annotated.` : `Message #${mesId} could not be annotated.`;
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
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'pg-lookup',
    callback: async (_args, value) => {
        const word = value?.trim();
        if (!word)
            return 'Please provide a word. Example: /pg-lookup hablar';
        await lookUpWord(word);
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
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'pg-panel',
    callback: async (args) => {
        const tab = String(args.tab || 'learn');
        openLearningPanel(PANEL_TABS.includes(tab) ? tab : 'learn');
        return 'Learning panel opened.';
    },
    helpString: 'Polyglot: open the learning panel. tab: wordbook | learn | settings',
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
