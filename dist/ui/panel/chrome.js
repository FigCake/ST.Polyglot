// ════════════════════════════
// Polyglot  ui/panel/chrome.ts
// ════════════════════════════
// Learning-panel window chrome: theme, background image, floating + drag.
//
// Dependencies: runtime.ts (getSettings)
import { getSettings } from '../../runtime.js';
export const PANEL_ID = 'pg-learning-panel';
/** PgPanel prefixes its box element id with "pg-box-". */
export const PANEL_BOX_ID = `pg-box-${PANEL_ID}`;
/** The panel box element (it carries the pg-sidebar class itself). */
export function findPanelEl() {
    return document.getElementById(PANEL_BOX_ID) ?? document.querySelector('.pg-sidebar');
}
/** Small-screen touch devices always use the docked layout. */
const isCompactTouch = () => window.matchMedia('(pointer: coarse) and (max-width: 600px)').matches;
// ── Theme ─────────────────────────────────────────────────────────────────────
/** Applies the saved theme and background image to the open panel. */
export function applyPanelTheme() {
    const panel = findPanelEl();
    if (!panel)
        return;
    const { panel_theme, panel_bg_image } = getSettings();
    // Dark is the stylesheet default, so it is expressed by the attribute's absence
    if (panel_theme && panel_theme !== 'dark')
        panel.dataset.pgTheme = panel_theme;
    else
        delete panel.dataset.pgTheme;
    // Strip embedded quotes so the value cannot break out of url("…")
    const safeUrl = panel_bg_image?.replace(/"/g, '%22') ?? '';
    if (safeUrl)
        panel.style.setProperty('--pg-panel-bg-image', `url("${safeUrl}")`);
    else
        panel.style.removeProperty('--pg-panel-bg-image');
    panel.toggleAttribute('data-has-bg', !!safeUrl); // drives the liquid-glass CSS
}
/**
 * Applies theme + floating state to a freshly opened panel.
 * The theme is re-applied over the next frames because ST may restyle the
 * box while it animates in.
 */
export function restorePanelChrome() {
    applyPanelTheme();
    requestAnimationFrame(applyPanelTheme);
    setTimeout(applyPanelTheme, 80);
    if (isCompactTouch())
        return;
    requestAnimationFrame(() => {
        const panel = findPanelEl();
        if (panel && getSettings().panel_floating)
            setFloating(panel, true);
    });
}
// ── Floating mode ─────────────────────────────────────────────────────────────
const POSITION_PROPS = ['top', 'left', 'right', 'bottom'];
/** Switches the panel between docked and free-floating (draggable) mode. */
export function setFloating(panel, on) {
    if (!on) {
        panel.classList.remove('pg-sidebar-floating');
        POSITION_PROPS.forEach(p => panel.style.removeProperty(p));
        return;
    }
    if (panel.classList.contains('pg-sidebar-floating'))
        return;
    const { top, left } = panel.getBoundingClientRect();
    panel.classList.add('pg-sidebar-floating');
    // !important beats the docked layout's positioning rules
    panel.style.setProperty('right', 'auto', 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
    panel.style.setProperty('top', `${top}px`, 'important');
    panel.style.setProperty('left', `${left}px`, 'important');
    wireDrag(panel);
}
const draggable = new WeakSet();
/** Lets the floating panel be dragged by its title bar (or body, if no title). Idempotent. */
function wireDrag(panel) {
    if (draggable.has(panel))
        return;
    draggable.add(panel);
    const handle = panel.querySelector('.pg-box-title') ?? panel;
    let offset = null;
    handle.addEventListener('pointerdown', e => {
        if (!panel.classList.contains('pg-sidebar-floating'))
            return;
        const target = e.target;
        // Controls keep their own behaviour; content panes keep scrolling
        if (target.closest('button, input, select, a'))
            return;
        if (handle === panel && target.closest('.pg-nav-view, .pg-box-pane'))
            return;
        const r = panel.getBoundingClientRect();
        offset = { x: e.clientX - r.left, y: e.clientY - r.top };
        panel.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    panel.addEventListener('pointermove', e => {
        if (!offset)
            return;
        const clamp = (v, max) => Math.max(0, Math.min(v, max));
        const x = clamp(e.clientX - offset.x, window.innerWidth - panel.offsetWidth);
        const y = clamp(e.clientY - offset.y, window.innerHeight - panel.offsetHeight);
        panel.style.setProperty('left', `${x}px`, 'important');
        panel.style.setProperty('top', `${y}px`, 'important');
    });
    const stop = () => { offset = null; };
    panel.addEventListener('pointerup', stop);
    panel.addEventListener('pointercancel', stop);
}
