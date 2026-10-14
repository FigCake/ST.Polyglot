import { t } from './i18n.js';
// ── HTML escaping ─────────────────────────────────────────────────────────────
const _esc = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
export function escapeHtml(str) {
    if (str == null)
        return '';
    return String(str).replace(/[&<>"']/g, c => _esc[c]);
}
// ── Element factory ───────────────────────────────────────────────────────────
/**
 * props: attrs → setAttribute  |  dataset → dataset  |  html → innerHTML  |  * → direct prop
 * String children become XSS-safe text nodes.
 */
export const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, val] of Object.entries(props)) {
        if (key === 'attrs')
            Object.entries(val).forEach(([k, v]) => node.setAttribute(k, v));
        else if (key === 'dataset')
            Object.assign(node.dataset, val);
        else if (key === 'html')
            node.innerHTML = val;
        else
            node[key] = val;
    }
    for (const child of children)
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    return node;
};
// ── Notification strip ────────────────────────────────────────────────────────
export function notify(message, level = 'info', ms = 3000) {
    let rack = document.getElementById('pg-notis');
    if (!rack) {
        rack = el('div', { id: 'pg-notis' });
        document.body.appendChild(rack);
    }
    const item = el('div', { className: `pg-noti pg-noti-${level}`, textContent: message });
    rack.appendChild(item);
    setTimeout(() => {
        item.classList.add('pg-noti-out');
        setTimeout(() => item.remove(), 320);
    }, ms);
}
/**
 * Shows a question with one button per choice. Resolves with the chosen value,
 * or null on Escape / backdrop tap.
 */
export function askChoice(question, choices) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            window.removeEventListener('keydown', onKey, true);
            wrap.remove();
            resolve(result);
        };
        const wrap = el('div', { className: 'pg-dim' }, [
            el('div', { className: 'pg-dialog', attrs: { role: 'dialog', 'aria-modal': 'true' } }, [
                el('p', { className: 'pg-dialog-txt', textContent: question }),
                el('div', { className: 'pg-dialog-row' }, choices.map(c => el('button', {
                    className: `pg-btn ${c.primary ? 'pg-btn-primary' : 'pg-btn-secondary'}`,
                    textContent: c.label,
                    onclick: () => finish(c.value),
                }))),
            ]),
        ]);
        // Backdrop tap closes the dialog (mobile UX)
        wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap)
            finish(null); });
        document.body.appendChild(wrap);
        // stopPropagation keeps ESC from also closing a parent PgPanel
        const onKey = (e) => { if (e.key === 'Escape') {
            e.stopPropagation();
            finish(null);
        } };
        window.addEventListener('keydown', onKey, true); // capture: runs before the panel's own Escape
        wrap.querySelector('.pg-btn-primary')?.focus();
    });
}
/** A read-only document in a scrollable dialog (Close, Escape or a backdrop tap closes it). */
export function showDocument(title, body) {
    const close = () => {
        window.removeEventListener('keydown', onKey, true);
        wrap.remove();
    };
    const wrap = el('div', { className: 'pg-dim' }, [
        el('div', { className: 'pg-dialog pg-doc-dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } }, [
            el('h3', { className: 'pg-doc-title', textContent: title }),
            Object.assign(body, { className: `${body.className} pg-doc-body`.trim() }),
            el('div', { className: 'pg-dialog-row' }, [
                el('button', { className: 'pg-btn pg-btn-primary', textContent: '✕', onclick: close, attrs: { 'aria-label': t('close') } }),
            ]),
        ]),
    ]);
    wrap.addEventListener('pointerdown', e => { if (e.target === wrap)
        close(); });
    const onKey = (e) => { if (e.key === 'Escape') {
        e.stopPropagation();
        close();
    } };
    window.addEventListener('keydown', onKey, true); // capture: runs before the panel's own Escape
    document.body.appendChild(wrap);
    wrap.querySelector('.pg-btn-primary')?.focus();
}
export async function askConfirm(question, { yes = t('confirmYes'), no = t('confirmNo') } = {}) {
    return (await askChoice(question, [
        { value: 'no', label: no },
        { value: 'yes', label: yes, primary: true },
    ])) === 'yes';
}
export function askInput(question, { initial = '', hint = '' } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        const field = el('input', {
            className: 'pg-field-inp', type: 'text', value: initial, placeholder: hint,
        });
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            window.removeEventListener('keydown', onKey, true);
            wrap.remove();
            resolve(result);
        };
        const wrap = el('div', { className: 'pg-dim' }, [
            el('div', { className: 'pg-dialog' }, [
                el('label', { className: 'pg-field-lbl', textContent: question }),
                field,
                el('div', { className: 'pg-dialog-row' }, [
                    el('button', { className: 'pg-btn pg-btn-secondary', textContent: t('confirmNo'), onclick: () => finish(null) }),
                    el('button', { className: 'pg-btn pg-btn-primary', textContent: t('confirmYes'), onclick: () => finish(field.value) }),
                ]),
            ]),
        ]);
        // Backdrop tap closes the dialog (mobile UX)
        wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap)
            finish(null); });
        document.body.appendChild(wrap);
        // On window, not the field, so keys work with focus on the buttons too.
        // stopPropagation keeps ESC from also closing a parent PgPanel.
        const onKey = (e) => {
            if (e.isComposing)
                return; // an IME's Enter commits the text, it does not submit
            if (e.key === 'Escape') {
                e.stopPropagation();
                finish(null);
            }
            // Enter on a focused button is that button's click (Cancel must cancel)
            if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement))
                finish(field.value);
        };
        window.addEventListener('keydown', onKey, true); // capture: runs before the panel's own Escape
        field.focus();
    });
}
// ── Panel system ──────────────────────────────────────────────────────────────
/** Open panels by id, so opening one again closes the old instance cleanly. */
const openPanels = new Map();
/** Floating panel; each instance owns its DOM and lifecycle. */
export class PgPanel {
    _alive;
    _onKeyDown;
    _onDismiss;
    panelId;
    wrap;
    box;
    body;
    constructor(node, { panelId, heading = '', extra = '', footer, onDismiss } = {}) {
        this.panelId = panelId || crypto.randomUUID();
        this._alive = false;
        this._onDismiss = typeof onDismiss === 'function' ? onDismiss : null;
        // The panel sits beside the chat, which stays usable: an Escape meant for ST (stop a
        // generation, cancel an edit), an IME or a popup must not close it — only one pressed
        // while focus is inside the panel
        this._onKeyDown = (e) => {
            if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing)
                return;
            if (e.target instanceof Node && this.box.contains(e.target))
                this.dismiss();
        };
        const hasHeading = Boolean(heading);
        const closeBtn = el('button', {
            className: hasHeading ? 'pg-box-x' : 'pg-box-x pg-box-x-float',
            innerHTML: '&times;',
            attrs: { 'aria-label': t('close') },
            onclick: () => this.dismiss(),
        });
        this.body = el('div', { className: 'pg-box-main' });
        if (typeof node === 'string')
            this.body.innerHTML = node;
        else if (node instanceof HTMLElement)
            this.body.appendChild(node);
        if (!hasHeading) {
            const navMenu = this.body.querySelector('.pg-nav-menu');
            if (navMenu)
                navMenu.prepend(closeBtn);
            else
                this.body.prepend(closeBtn);
        }
        const boxKids = hasHeading
            ? [
                el('div', { className: 'pg-box-tit' }, [
                    el('div', { className: 'pg-box-tit-left' }, [
                        el('span', { textContent: heading }),
                    ]),
                    closeBtn,
                ]),
                this.body,
            ]
            : [this.body];
        if (footer instanceof HTMLElement)
            boxKids.push(footer);
        this.box = el('div', {
            className: ['pg-box', extra].filter(Boolean).join(' '),
            id: `pg-box-${this.panelId}`,
            // tabindex: a click anywhere in the panel puts focus in it (for its Escape)
            attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': heading || 'Panel', tabindex: '-1' },
        }, boxKids);
        this.wrap = el('div', {
            className: 'pg-dim',
            id: `pg-dim-${this.panelId}`,
        }, [this.box]);
        this.wrap.addEventListener('click', (e) => { if (e.target === this.wrap)
            this.dismiss(); });
    }
    mount() {
        openPanels.get(this.panelId)?.dismiss();
        openPanels.set(this.panelId, this);
        this._alive = true;
        document.body.appendChild(this.wrap);
        document.addEventListener('keydown', this._onKeyDown);
        return this;
    }
    dismiss() {
        if (!this._alive)
            return;
        this._alive = false;
        this.wrap.remove();
        document.removeEventListener('keydown', this._onKeyDown);
        if (openPanels.get(this.panelId) === this)
            openPanels.delete(this.panelId);
        this._onDismiss?.();
    }
    get isOpen() { return this._alive; }
}
/** Constructs and mounts a PgPanel. */
export function openPanel(node, cfg = {}) {
    return new PgPanel(node, cfg).mount();
}
// ── Tab view ──────────────────────────────────────────────────────────────────
/** Tabbed view whose panes render once, on first activation. */
export function buildTabView(panes, activePaneId = null) {
    const activeId = activePaneId || (panes[0]?.id ?? '');
    const nodeCache = new Map();
    const viewport = el('div', { className: 'pg-nav-view' });
    const showPane = (id) => {
        if (!nodeCache.has(id)) {
            const pane = panes.find(p => p.id === id);
            if (pane)
                nodeCache.set(id, pane.render());
        }
        else
            panes.find(p => p.id === id)?.onShow?.();
        const cached = nodeCache.get(id);
        if (cached)
            viewport.replaceChildren(cached);
    };
    showPane(activeId);
    let activeBtn = null;
    const strip = el('div', { className: 'pg-nav-menu' });
    for (const pane of panes) {
        const btn = el('button', {
            className: 'pg-nav-tab' + (pane.id === activeId ? ' active' : ''),
            textContent: pane.name,
            dataset: { tabId: pane.id },
            onclick: () => {
                if (activeBtn === btn)
                    return;
                if (activeBtn)
                    activeBtn.classList.remove('active');
                btn.classList.add('active');
                activeBtn = btn;
                showPane(pane.id);
            },
        });
        if (pane.id === activeId)
            activeBtn = btn;
        strip.appendChild(btn);
    }
    return el('div', { className: 'pg-nav' }, [strip, viewport]);
}
