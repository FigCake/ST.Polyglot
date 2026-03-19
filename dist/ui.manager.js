// ════════════════════════════
// Polyglot  ui.manager.ts
// ════════════════════════════
// ── HTML escaping ─────────────────────────────────────────────────────────────
const _esc = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
export function escapeHtml(str) {
    if (str == null)
        return '';
    return String(str).replace(/[&<>"']/g, c => _esc[c]);
}
export function generateId() {
    return crypto.randomUUID();
}
// ── Element factory ───────────────────────────────────────────────────────────
/**
 * Thin element factory.
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
// ── Modal dialogs ─────────────────────────────────────────────────────────────
export function askConfirm(question, { yes: yesLabel = 'Confirm', no: noLabel = 'Cancel' } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            document.removeEventListener('keydown', onKey);
            wrap.remove();
            resolve(result);
        };
        const wrap = el('div', { className: 'pg-dim' }, [
            el('div', { className: 'pg-dialog' }, [
                el('p', { className: 'pg-dialog-txt', textContent: question }),
                el('div', { className: 'pg-dialog-row' }, [
                    el('button', { className: 'pg-btn pg-btn-secondary', textContent: noLabel, onclick: () => finish(false) }),
                    el('button', { className: 'pg-btn pg-btn-primary', textContent: yesLabel, onclick: () => finish(true) }),
                ]),
            ]),
        ]);
        // Backdrop tap closes the dialog (mobile UX)
        wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap)
            finish(false); });
        document.body.appendChild(wrap);
        // stopPropagation prevents ESC from bubbling up to a parent PgPanel and closing it too
        const onKey = (e) => { if (e.key === 'Escape') {
            e.stopPropagation();
            finish(false);
        } };
        document.addEventListener('keydown', onKey);
    });
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
            document.removeEventListener('keydown', onKey);
            wrap.remove();
            resolve(result);
        };
        const wrap = el('div', { className: 'pg-dim' }, [
            el('div', { className: 'pg-dialog' }, [
                el('label', { className: 'pg-field-lbl', textContent: question }),
                field,
                el('div', { className: 'pg-dialog-row' }, [
                    el('button', { className: 'pg-btn pg-btn-secondary', textContent: 'Cancel', onclick: () => finish(null) }),
                    el('button', { className: 'pg-btn pg-btn-primary', textContent: 'OK', onclick: () => finish(field.value) }),
                ]),
            ]),
        ]);
        // Backdrop tap closes the dialog (mobile UX)
        wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap)
            finish(null); });
        document.body.appendChild(wrap);
        // Register ESC on document (not just the field) so it works even when
        // focus is on the Cancel/OK buttons after Tab navigation.
        // stopPropagation prevents ESC from bubbling up to a parent PgPanel and closing it too.
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                finish(null);
            }
            if (e.key === 'Enter')
                finish(field.value);
        };
        document.addEventListener('keydown', onKey);
        field.focus();
    });
}
// ── Panel system ──────────────────────────────────────────────────────────────
/** Module-level registry — maps panelId → PgPanel so dismissPanel can reach live instances. */
const _panelRegistry = new Map();
/**
 * Self-contained floating panel.
 * Each instance owns its own DOM and lifecycle.
 */
export class PgPanel {
    _alive;
    _onKeyDown;
    _onDismiss;
    panelId;
    wrap;
    box;
    body;
    constructor(node, { panelId, heading = '', extra = '', footer, onDismiss } = {}) {
        this.panelId = panelId || generateId();
        this._alive = false;
        this._onDismiss = typeof onDismiss === 'function' ? onDismiss : null;
        this._onKeyDown = (e) => { if (e.key === 'Escape')
            this.dismiss(); };
        const hasHeading = Boolean(heading);
        const closeBtn = el('button', {
            className: hasHeading ? 'pg-box-x' : 'pg-box-x pg-box-x-float',
            innerHTML: '&times;',
            attrs: { 'aria-label': 'Close' },
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
            attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': heading || 'Panel' },
        }, boxKids);
        this.wrap = el('div', {
            className: 'pg-dim',
            id: `pg-dim-${this.panelId}`,
        }, [this.box]);
        this.wrap.addEventListener('click', (e) => { if (e.target === this.wrap)
            this.dismiss(); });
    }
    mount() {
        document.getElementById(`pg-dim-${this.panelId}`)?.remove();
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
        _panelRegistry.delete(this.panelId);
        this._onDismiss?.();
    }
    get isOpen() { return this._alive; }
}
/** Convenience wrapper — constructs and mounts a PgPanel in one call. */
export function openPanel(node, cfg = {}) {
    const panel = new PgPanel(node, cfg).mount();
    if (panel.panelId)
        _panelRegistry.set(panel.panelId, panel);
    return panel;
}
/**
 * Dismisses the panel with the given panelId via its PgPanel instance,
 * so that keydown listeners and onDismiss callbacks are properly cleaned up.
 */
export function dismissPanel(panelId) {
    const panel = _panelRegistry.get(panelId);
    if (panel) {
        panel.dismiss(); // dismiss() already calls _panelRegistry.delete(this.panelId)
    }
}
// ── Tab view ──────────────────────────────────────────────────────────────────
/**
 * Builds a tabbed view with lazy-initialising panes.
 * Each pane carries a render() called once on first activation; result is cached.
 */
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
