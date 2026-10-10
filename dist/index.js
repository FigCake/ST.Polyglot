// ════════════════════════════
// Polyglot  index.ts
// ════════════════════════════
// Entry point: wires modules together, injects chat-UI buttons, subscribes to
// ST events and registers slash commands. Feature logic lives elsewhere:
//
//   runtime.ts            settings + settings-bound helpers (ai client, getLang…)
//   data-store.ts         the learner's data (wordbook, sets, wrong answers) in a server file
//   speech.ts             text-to-speech and pronunciation scoring
//   ui/learning-panel.ts  the side panel and word lookup (ui/panel/* for tabs and chrome)
//   ai/client.ts          every AI request: JSON repair, one strict retry, partial results
//   export/pdf.ts         printable flashcard deck
import { setupTapToTranslate, removeTapBubbles, abortAllTapTranslate } from './ui/tap-translate.js';
import { buildSettingsPanel } from './ui/settings-ui.js';
import { openLearningPanel, lookUpWord, cancelLookup, PANEL_TABS } from './ui/learning-panel.js';
import { getSettings, getLang, getNativeLang, ai, getContext } from './runtime.js';
import { DELAY } from './constants.js';
import { runChecker } from './features/checker.js';
import { pruneOrphanSets, migrateChatWordbook } from './wordbook.js';
import { refreshWordbook } from './ui/wordbook-ui.js';
import { initDataStore, onDataReplaced, storeMode } from './data-store.js';
import { notify } from './ui.manager.js';
import { setOpenPanelFn, injectAnnotateButtons, runAnnotator, restoreAnnotations, restoreWithRetry, resetChatState, forgetMessage, } from './annotator.js';
import { t } from './i18n.js';
import { setupPlainCopy } from './plain-text.js';
import { restoreFurigana, restoreFuriganaWithRetry, autoFurigana, forgetFurigana, resetFuriganaState, applyFuriganaDisplay, onFuriganaSettingChange, setupReadingEditor, } from './furigana/messages.js';
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { eventSource, event_types } from '../../../../../script.js';
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { SlashCommand } from '../../../../slash-commands/SlashCommand.js';
// @ts-expect-error — ST runtime module; types provided via tsconfig paths → st-stubs.d.ts
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../../slash-commands/SlashCommandArgument.js';
// ════════════════════════════
// Chat-UI entry points
// ════════════════════════════
const WAND_ICON = '<i class="fa-solid fa-earth-europe"></i>';
const SPINNER_ICON = '<i class="fa-solid fa-spinner fa-spin"></i>';
const checkerDeps = () => ({ ai, getSettings, getLang, getNativeLang, setWandBusy });
/** Adds the 🌍 input-assistant button next to ST's send button. */
function injectWandButton() {
    if (!getSettings().enabled_checker)
        return;
    if (document.getElementById('pg-wand-btn'))
        return;
    const sendBtn = document.getElementById('send_but');
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
    const menu = document.getElementById('extensionsMenu');
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
        $('#extensionsMenu').hide(); // ST manages this menu via jQuery
        openLearningPanel();
    });
    menu.appendChild(item);
}
function injectChatButtons() {
    injectWandButton();
    injectAnnotateButtons();
}
// ════════════════════════════
// Chat lifecycle
// ════════════════════════════
const mesSelector = (mesId) => `.mes[mesid="${CSS.escape(mesId)}"]`;
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
    cancelLookup();
    abortAllTapTranslate();
    removeTapBubbles();
    // Wait for ST to finish rendering the new chat's DOM.
    setTimeout(() => {
        injectChatButtons();
        restoreAnnotations();
        restoreFuriganaWithRetry();
        void adoptChatWordbook();
    }, DELAY.chatSwitch);
}
/** Subscribes to a `pg:*-toggle` event dispatched by the settings UI. */
function onToggle(name, handler) {
    document.addEventListener(name, e => handler(e.detail.on));
}
// ════════════════════════════
// Initialisation
// ════════════════════════════
(function init() {
    setOpenPanelFn(openLearningPanel); // highlight clicks in annotator.ts open the panel
    buildSettingsPanel();
    onDataReplaced(refreshWordbook);
    eventSource.on(event_types.APP_READY, () => {
        // Words are readable at once (from memory); the file load merges them in
        void initDataStore().then(() => {
            if (storeMode() !== 'file')
                return;
            pruneOrphanSets(); // safe only after the full data load
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
        if (mesId !== undefined)
            autoFurigana(String(mesId));
    });
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_SWIPED, (id) => {
        forgetMessage(String(id));
        forgetFurigana(String(id));
    });
    injectChatButtons();
    injectExtensionsMenuEntry();
    onToggle('pg:checker-toggle', on => {
        if (on)
            injectWandButton();
        else
            document.getElementById('pg-wand-btn')?.remove();
    });
    document.addEventListener('pg:language-change', onFuriganaSettingChange);
    onToggle('pg:annotator-toggle', on => {
        if (on)
            injectAnnotateButtons();
        else
            document.querySelectorAll('.pg-annotate-btn, .pg-open-btn').forEach(b => b.remove());
    });
})();
// ════════════════════════════
// Slash Commands
// ════════════════════════════
// ═ /pg-check
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'pg-check',
    callback: async () => {
        await runChecker(checkerDeps());
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
        const msgEl = document.querySelector(mesSelector(mesId));
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
// ═ /pg-panel
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
