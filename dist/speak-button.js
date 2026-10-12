// The 🔊 button of words and examples. A dot marks a sound kept as a file
// (a recording, or a voice service's sound): it plays without asking a service.
import { html } from './html.js';
import { t } from './i18n.js';
export const speakButton = ({ saved, label, cls = '', action }) => html `
    <button class="pg-speak-btn ${cls} ${saved && 'pg-speak-saved'}" ${action && html `data-action="${action}"`}
            title="${saved ? t('snd.listenSaved') : label}" aria-label="${saved ? `${label} (${t('snd.listenSaved')})` : label}">🔊</button>`;
