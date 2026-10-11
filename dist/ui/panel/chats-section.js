// "Words by chat": how many words each chat has in the shared wordbook, with
// multi-select to move them into the open chat or delete them.
import { html, setHtml } from '../../html.js';
import { t } from '../../i18n.js';
import { askConfirm, notify } from '../../ui.manager.js';
import { currentChatId } from '../../storage.js';
import { wordbookByChat, moveChatsHere, deleteChatWords } from '../../wordbook.js';
import { refreshWordbook } from '../wordbook-ui.js';
function render(el) {
    const groups = wordbookByChat();
    const open = currentChatId();
    setHtml(el, html `
        <div class="pg-chats-head">
            <span class="pg-pset-label">${t('pnl.set.chats')}</span>
        </div>
        ${groups.length ? html `
        <ul class="pg-chats-list">${groups.map(g => html `
            <li>
                <label class="pg-chats-row ${g.chatId === open && 'pg-chats-current'}" title="${g.chatId || t('pnl.set.unsorted')}">
                    <input type="checkbox" class="pg-chats-check" value="${g.chatId}">
                    <span class="pg-chats-name">${g.chatId || t('pnl.set.unsorted')}</span>
                    ${g.chatId === open && html `<span class="pg-chats-badge">${t('pnl.set.thisChat')}</span>`}
                    <span class="pg-chats-count">${g.count}</span>
                </label>
            </li>`)}
        </ul>
        <div class="pg-chats-actions" hidden>
            <button class="pg-btn pg-btn-secondary" data-chats="move">${t('pnl.set.moveHere')}</button>
            <button class="pg-btn pg-btn-secondary pg-btn-danger" data-chats="delete">${t('pnl.set.deleteChats')}</button>
        </div>` : html `<div class="pg-pset-hint">${t('pnl.set.chatsEmpty')}</div>`}`);
}
const selected = (el) => [...el.querySelectorAll('.pg-chats-check:checked')].map(c => c.value);
async function act(el, action) {
    const chats = selected(el);
    if (!chats.length)
        return;
    if (action === 'move') {
        if (!currentChatId()) {
            notify(t('pnl.set.noChatOpen'), 'warn');
            return;
        }
        notify(t('pnl.set.moved', { n: moveChatsHere(chats) }), 'ok');
    }
    else {
        if (!(await askConfirm(t('pnl.set.deleteChatsConfirm', { n: chats.length }), { yes: t('wb.delSetBtn'), no: t('confirmNo') })))
            return;
        notify(t('pnl.set.chatsDeleted', { n: deleteChatWords(chats) }), 'ok');
    }
    render(el);
    refreshWordbook();
}
/** Renders the section into `el` and keeps it up to date after its own actions. */
export function mountChatsSection(el) {
    render(el);
    el.addEventListener('change', () => {
        const actions = el.querySelector('.pg-chats-actions');
        if (actions)
            actions.hidden = selected(el).length === 0;
    });
    el.addEventListener('click', e => {
        const action = e.target.closest('[data-chats]')?.dataset.chats;
        if (action)
            act(el, action);
    });
}
