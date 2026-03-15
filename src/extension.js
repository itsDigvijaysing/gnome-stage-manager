/**
 * Stage Manager - GNOME Shell Extension
 *
 * macOS Stage Manager for GNOME.
 *
 * Compatible with GNOME 45+ (ESM), Wayland and X11.
 */

import Meta from 'gi://Meta';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';


const THUMB_W = 160;
const THUMB_H = 100;
const ICON_SIZE = 24;
const MAX_GROUPS = 10;
const BELL_SIGMA = 1.4; // gaussian spread for bell curve scaling


// ─── Helpers ────────────────────────────────────────────────────────────────

function _isNormal(win) {
    if (!win) return false;
    if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
    if (win.skip_taskbar || win.is_attached_dialog()) return false;
    if (win.is_always_on_all_workspaces()) return false;
    return true;
}

function _nullCloneSources(actor) {
    try {
        if (actor instanceof Clutter.Clone) {
            try { actor.set_source(null); } catch (_e) { /* */ }
        }
        const children = actor.get_children ? actor.get_children() : [];
        for (const child of children)
            _nullCloneSources(child);
    } catch (_e) { /* actor already gone */ }
}

function _groupByApp(workspace, focusedWindow) {
    const tracker = Shell.WindowTracker.get_default();
    const appMap = new Map();

    const allWins = workspace.list_windows().filter(w => _isNormal(w));
    const sorted = allWins.sort((a, b) =>
        (b.get_user_time() || 0) - (a.get_user_time() || 0)
    );

    let activeAppId = null;
    if (focusedWindow) {
        const fa = tracker.get_window_app(focusedWindow);
        if (fa) activeAppId = fa.get_id();
    }

    for (const win of sorted) {
        const app = tracker.get_window_app(win);
        if (!app) continue;
        const id = app.get_id();
        if (id === activeAppId) continue;

        if (!appMap.has(id))
            appMap.set(id, { app, windows: [] });
        appMap.get(id).windows.push(win);
    }

    return [...appMap.values()];
}

/**
 * Gaussian bell curve: returns a value between 0 and 1.
 * Peak at dist=0, falls off with sigma.
 */
function _bellCurve(dist, sigma) {
    return Math.exp(-(dist * dist) / (2 * sigma * sigma));
}


// ─── MaximizeToWorkspace ────────────────────────────────────────────────────

class MaximizeToWorkspace {
    constructor(settings) {
        this._settings = settings;
        this._sigs = [];
        this._timers = [];
        this._moved = new Set();
    }

    enable() {
        this._sig(global.window_manager, 'size-change', this._onSize.bind(this));
        this._sig(global.window_manager, 'destroy', (_wm, actor) => {
            try { if (actor.meta_window) this._moved.delete(actor.meta_window); } catch (_) { /* */ }
        });
    }

    disable() {
        this._sigs.splice(0).forEach(s => { try { s.o.disconnect(s.i); } catch (_) { /* */ } });
        this._timers.splice(0).forEach(id => GLib.source_remove(id));
        this._moved.clear();
    }

    _sig(o, s, cb) { this._sigs.push({ o, i: o.connect(s, cb) }); }

    _onSize(_wm, actor, change) {
        if (!this._settings.get_boolean('enable-maximize-to-workspace')) return;
        if (change !== Meta.SizeChange.MAXIMIZE) return;
        const win = actor.meta_window;
        if (!win || !_isNormal(win) || this._moved.has(win)) return;

        const wsm = global.workspace_manager;
        const ci = wsm.get_active_workspace_index();
        const cws = wsm.get_workspace_by_index(ci);
        const siblings = cws.list_windows().filter(w => w !== win && _isNormal(w) && !w.minimized);
        if (siblings.length === 0) return;

        let ti = -1;
        for (let i = 0; i < wsm.get_n_workspaces(); i++) {
            if (i === ci) continue;
            if (wsm.get_workspace_by_index(i).list_windows().filter(w => w !== win && _isNormal(w)).length === 0) {
                ti = i; break;
            }
        }
        if (ti === -1) {
            wsm.append_new_workspace(false, global.get_current_time());
            ti = wsm.get_n_workspaces() - 1;
        }
        if (ti === ci) return;

        this._moved.add(win);
        win.change_workspace_by_index(ti, false);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._timers.splice(this._timers.indexOf(id), 1);
            const ws = wsm.get_workspace_by_index(ti);
            if (ws) { ws.activate(global.get_current_time()); win.activate(global.get_current_time()); }
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(id);
    }
}


// ─── StageSidebar ───────────────────────────────────────────────────────────

class StageSidebar {
    constructor(settings) {
        this._settings = settings;
        this._sigs = [];
        this._setSigs = [];
        this._cards = [];
        this._panel = null;
        this._edge = null;
        this._box = null;
        this._scroll = null;
        this._preview = null;
        this._hoverTimer = null;
        this._refreshTimer = null;
        this._hideTimer = null;
        this._visible = false;
        this._hovered = false;
        this._animating = false;
        this._hoveredIdx = -1;
    }

    // ── Settings getters ──
    get _PANEL_W() { return this._settings.get_int('sidebar-width'); }
    get _SLIDE_MS() { return this._settings.get_int('animation-duration'); }
    get _HIDE_DELAY_MS() { return this._settings.get_int('auto-hide-delay'); }
    get _EDGE_W() { return this._settings.get_int('edge-trigger-width'); }
    get _BASE_SCALE() { return this._settings.get_int('card-base-scale') / 100.0; }
    get _PERSP_ANGLE() { return this._settings.get_int('perspective-angle'); }

    enable() {
        this._build();
        this._wire();
        if (!this._settings.get_boolean('sidebar-auto-hide'))
            this._show();
        else if (this._visible)
            this._refresh();
    }

    disable() {
        this._kill('_refreshTimer');
        this._kill('_hideTimer');
        this._kill('_hoverTimer');
        this._sigs.splice(0).forEach(s => { try { s.o.disconnect(s.i); } catch (_) { /* */ } });
        this._setSigs.splice(0).forEach(id => { try { this._settings.disconnect(id); } catch (_) { /* */ } });
        this._destroyPreview();
        this._safeDestroyContent();
        this._cards = [];
        this._box = null;
        this._scroll = null;
        if (this._panel) {
            Main.layoutManager.removeChrome(this._panel);
            this._panel.destroy();
            this._panel = null;
        }
        if (this._edge) {
            Main.layoutManager.removeChrome(this._edge);
            this._edge.destroy();
            this._edge = null;
        }
    }

    _build() {
        const mon = Main.layoutManager.primaryMonitor;
        const topH = Main.panel ? Main.panel.height : 0;
        const panelW = this._PANEL_W;
        const edgeW = this._EDGE_W;
        const panelH = mon.height - topH;

        // Edge trigger
        this._edge = new St.Widget({
            reactive: true, track_hover: true,
            style: 'background-color: transparent;',
        });
        this._edge.set_size(edgeW, panelH);
        this._edge.set_position(mon.x, mon.y + topH);
        Main.layoutManager.addChrome(this._edge, { affectsInputRegion: true, trackFullscreen: false });
        this._edge.connect('enter-event', () => {
            if (!this._fullscreen()) this._show();
        });

        // Panel
        this._panel = new St.Widget({
            reactive: true, track_hover: true,
            style: 'background-color: transparent;',
        });
        this._panel.set_size(panelW, panelH);
        this._panel.set_position(mon.x - panelW, mon.y + topH);
        this._visible = false;
        Main.layoutManager.addChrome(this._panel, { affectsInputRegion: true, trackFullscreen: false });

        // ScrollView → BoxLayout
        this._scroll = new St.ScrollView({
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            clip_to_allocation: true,
        });
        this._scroll.set_size(panelW, panelH);
        this._panel.add_child(this._scroll);

        this._box = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            style: 'padding: 50px 0px; spacing: 6px;',
        });
        this._scroll.set_child(this._box);

        this._scroll.connect('scroll-event', (_actor, event) => {
            const adj = this._scroll.vadjustment;
            const [, dy] = event.get_scroll_delta();
            adj.value = Math.max(0, Math.min(adj.upper - adj.page_size, adj.value + dy * 55));
            return Clutter.EVENT_STOP;
        });

        this._panel.connect('enter-event', () => {
            this._hovered = true;
            this._kill('_hideTimer');
        });
        this._panel.connect('leave-event', () => {
            this._hovered = false;
            this._hoveredIdx = -1;
            this._resetAllCardScales();
            this._destroyPreview();
            if (this._settings.get_boolean('sidebar-auto-hide'))
                this._scheduleHide();
        });
    }

    _wire() {
        const sig = (o, s, cb) => { this._sigs.push({ o, i: o.connect(s, cb) }); };
        sig(global.display, 'notify::focus-window', () => this._scheduleRefresh());
        sig(global.window_manager, 'map', () => this._scheduleRefresh());
        sig(global.window_manager, 'destroy', () => this._scheduleRefresh());
        sig(global.window_manager, 'minimize', () => this._scheduleRefresh());
        sig(global.window_manager, 'unminimize', () => this._scheduleRefresh());
        sig(global.workspace_manager, 'active-workspace-changed', () => this._scheduleRefresh());
        sig(global.workspace_manager, 'workspace-added', () => this._scheduleRefresh());
        sig(global.workspace_manager, 'workspace-removed', () => this._scheduleRefresh());
        sig(global.display, 'in-fullscreen-changed', () => this._onFullscreen());

        this._setSigs.push(this._settings.connect('changed::enable-stage-sidebar', () => {
            if (!this._settings.get_boolean('enable-stage-sidebar') && this._visible) this._hide();
        }));
        this._setSigs.push(this._settings.connect('changed::sidebar-mode', () => {
            if (this._visible) this._refresh();
        }));
        this._setSigs.push(this._settings.connect('changed::sidebar-auto-hide', () => {
            if (this._settings.get_boolean('sidebar-auto-hide')) {
                if (!this._hovered) this._scheduleHide();
            } else {
                this._show();
            }
        }));
        this._setSigs.push(this._settings.connect('changed::show-app-icons', () => {
            if (this._visible) this._refresh();
        }));
        this._setSigs.push(this._settings.connect('changed::card-base-scale', () => {
            if (this._visible) this._refresh();
        }));
        this._setSigs.push(this._settings.connect('changed::perspective-angle', () => {
            if (this._visible) this._refresh();
        }));
    }

    // ── Fullscreen ──

    _fullscreen() {
        try { return global.display.get_monitor_in_fullscreen(Main.layoutManager.primaryMonitor.index); }
        catch (_) { return false; }
    }

    _onFullscreen() {
        if (this._fullscreen()) {
            this._destroyPreview();
            if (this._visible) {
                this._visible = false;
                this._animating = false;
                this._panel.remove_all_transitions();
                this._panel.set_position(Main.layoutManager.primaryMonitor.x - this._PANEL_W, this._panel.y);
            }
            this._edge?.hide();
        } else {
            if (this._settings.get_boolean('enable-stage-sidebar'))
                this._edge?.show();
        }
    }

    // ── Show / Hide ──

    _show() {
        if (this._visible || this._animating) return;
        if (!this._settings.get_boolean('enable-stage-sidebar') || this._fullscreen()) return;

        this._visible = true;
        this._animating = true;
        this._kill('_hideTimer');
        this._refresh();

        this._panel.remove_all_transitions();
        this._panel.ease({
            x: Main.layoutManager.primaryMonitor.x,
            duration: this._SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { this._animating = false; },
        });
    }

    _hide() {
        if (!this._visible || this._animating) return;

        this._visible = false;
        this._animating = true;
        this._destroyPreview();

        this._panel.remove_all_transitions();
        this._panel.ease({
            x: Main.layoutManager.primaryMonitor.x - this._PANEL_W,
            duration: this._SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { this._animating = false; },
        });
    }

    _scheduleHide() {
        this._kill('_hideTimer');
        this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._HIDE_DELAY_MS, () => {
            this._hideTimer = null;
            if (!this._hovered) this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleRefresh() {
        if (this._refreshTimer) return;
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._refreshTimer = null;
            if (this._visible && !this._hovered) this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Render ──

    _refresh() {
        if (!this._settings.get_boolean('enable-stage-sidebar')) return;

        this._cards = [];
        this._hoveredIdx = -1;
        this._safeDestroyContent();

        const mode = this._settings.get_string('sidebar-mode');

        if (mode === 'workspaces')
            this._refreshWorkspaces();
        else
            this._refreshApps();

        // Apply initial small scale + perspective to all cards
        this._resetAllCardScales();
    }

    _refreshApps() {
        const activeWs = global.workspace_manager.get_active_workspace();
        const focusedWin = global.display.get_focus_window();
        const groups = _groupByApp(activeWs, focusedWin).slice(0, MAX_GROUPS);

        for (const group of groups) {
            try {
                const card = this._makeAppCard(group);
                if (card) {
                    this._box.add_child(card);
                    this._cards.push(card);
                }
            } catch (e) {
                console.error(`[StageManager] card error: ${e.message}`);
            }
        }
    }

    _refreshWorkspaces() {
        const wsm = global.workspace_manager;
        const activeIdx = wsm.get_active_workspace_index();
        const n = wsm.get_n_workspaces();
        const showCurrent = this._settings.get_boolean('show-workspace-current');

        for (let i = 0; i < n; i++) {
            if (!showCurrent && i === activeIdx) continue;
            const ws = wsm.get_workspace_by_index(i);
            const wins = ws.list_windows().filter(w => _isNormal(w));
            if (wins.length === 0 && i !== activeIdx) continue;

            try {
                const card = this._makeWorkspaceCard(ws, wins, i, i === activeIdx);
                if (card) {
                    this._box.add_child(card);
                    this._cards.push(card);
                }
            } catch (e) {
                console.error(`[StageManager] ws card error: ${e.message}`);
            }
        }
    }

    _safeDestroyContent() {
        if (!this._box) return;
        try {
            _nullCloneSources(this._box);
            this._box.destroy_all_children();
        } catch (_e) { /* */ }
    }

    // ── Card builders ──

    _makeAppCard(group) {
        const { app, windows } = group;

        const card = new St.BoxLayout({
            vertical: true, reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 6px 12px;',
        });

        const thumb = this._makeThumb(windows);
        card.add_child(thumb);
        card._thumb = thumb;

        if (app && this._settings.get_boolean('show-app-icons')) {
            const iconBox = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                style: 'margin-top: 6px;',
            });
            iconBox.add_child(app.create_icon_texture(ICON_SIZE));
            card.add_child(iconBox);
        }

        // Pivot + perspective applied by _resetAllCardScales
        card.set_pivot_point(0.0, 0.5);

        const idx = this._cards.length; // will be the index after push
        this._wireCardEvents(card, thumb, windows, idx);

        card.connect('button-release-event', () => {
            this._destroyPreview();
            this._activate(group);
            return Clutter.EVENT_STOP;
        });

        return card;
    }

    _makeWorkspaceCard(ws, wins, wsIndex, isCurrent) {
        const card = new St.BoxLayout({
            vertical: true, reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 6px 12px;',
        });

        const thumb = this._makeThumb(wins);
        card.add_child(thumb);
        card._thumb = thumb;

        // Label with highlight for current workspace
        const labelStyle = isCurrent
            ? 'margin-top: 6px; color: rgba(140,180,255,0.9); font-size: 11px; font-weight: bold;'
            : 'margin-top: 6px; color: rgba(255,255,255,0.6); font-size: 11px;';
        const label = new St.Label({
            text: isCurrent ? `Workspace ${wsIndex + 1} (current)` : `Workspace ${wsIndex + 1}`,
            x_align: Clutter.ActorAlign.CENTER,
            style: labelStyle,
        });
        card.add_child(label);

        if (wins.length > 0) {
            const count = new St.Label({
                text: `${wins.length} window${wins.length > 1 ? 's' : ''}`,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'color: rgba(255,255,255,0.35); font-size: 10px;',
            });
            card.add_child(count);
        }

        card.set_pivot_point(0.0, 0.5);

        const idx = this._cards.length;
        this._wireCardEvents(card, thumb, wins, idx);

        card.connect('button-release-event', () => {
            this._destroyPreview();
            if (!isCurrent) {
                ws.activate(global.get_current_time());
            }
            if (this._settings.get_boolean('sidebar-auto-hide'))
                this._scheduleHide();
            this._scheduleRefresh();
            return Clutter.EVENT_STOP;
        });

        return card;
    }

    _makeThumb(windows) {
        const thumb = new St.Widget({
            reactive: true,
            style: 'border-radius: 12px; background-color: rgba(30,30,34,0.55);',
        });

        let hasClone = false;
        const visibleWin = windows.find(w => !w.minimized && w.get_compositor_private());
        if (visibleWin) {
            const actor = visibleWin.get_compositor_private();
            if (actor) {
                try {
                    const clone = new Clutter.Clone({
                        source: actor,
                        width: THUMB_W,
                        height: THUMB_H,
                    });
                    thumb.add_child(clone);
                    hasClone = true;
                } catch (_e) { /* disposed */ }
            }
        }

        if (!hasClone) {
            const tracker = Shell.WindowTracker.get_default();
            const win = windows[0];
            const app = win ? tracker.get_window_app(win) : null;
            if (app) {
                const icon = app.create_icon_texture(48);
                icon.set_position((THUMB_W - 48) / 2, (THUMB_H - 48) / 2);
                thumb.add_child(icon);
            }
            thumb.set_size(THUMB_W, THUMB_H);
        }

        return thumb;
    }

    // ── Bell curve scaling ──

    /**
     * Reset all cards to their resting state: small + perspective.
     */
    _resetAllCardScales() {
        const base = this._BASE_SCALE;
        const angle = this._PERSP_ANGLE;
        for (const card of this._cards) {
            card.remove_all_transitions();
            card.set_scale(base, base);
            card.rotation_angle_y = angle;
            card.set_opacity(190);
        }
    }

    /**
     * Apply bell curve scaling: hovered card is full size,
     * neighbors scale down smoothly based on distance.
     */
    _applyBellCurve(hoveredIdx) {
        const base = this._BASE_SCALE;
        const angle = this._PERSP_ANGLE;

        for (let i = 0; i < this._cards.length; i++) {
            const dist = Math.abs(i - hoveredIdx);
            const factor = _bellCurve(dist, BELL_SIGMA);
            // Scale: base + (1-base) * factor → ranges from base to 1.0
            const s = base + (1.0 - base) * factor;
            // Perspective: full angle at dist=far, 0 at hovered
            const rot = angle * (1.0 - factor);
            // Opacity: 190 at far, 255 at hovered
            const op = Math.round(190 + 65 * factor);

            this._cards[i].ease({
                scale_x: s, scale_y: s,
                rotation_angle_y: rot,
                opacity: op,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    // ── Card events ──

    _wireCardEvents(card, thumb, windows, cardIdx) {
        card.connect('enter-event', () => {
            this._hovered = true;
            this._kill('_hideTimer');
            this._hoveredIdx = cardIdx;

            // Bell curve scale all cards
            this._applyBellCurve(cardIdx);

            // Glow on hovered thumb
            thumb.set_style('border-radius: 12px; background-color: rgba(50,50,58,0.75); box-shadow: 0 4px 20px rgba(120,140,255,0.18);');

            // Preview
            this._kill('_hoverTimer');
            this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                this._hoverTimer = null;
                this._showPreview(card, windows);
                return GLib.SOURCE_REMOVE;
            });
        });

        card.connect('leave-event', () => {
            this._hoveredIdx = -1;
            // Return all cards to resting scale
            const base = this._BASE_SCALE;
            const angle = this._PERSP_ANGLE;
            for (const c of this._cards) {
                c.ease({
                    scale_x: base, scale_y: base,
                    rotation_angle_y: angle,
                    opacity: 190,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            thumb.set_style('border-radius: 12px; background-color: rgba(30,30,34,0.55);');
            this._kill('_hoverTimer');
            this._destroyPreview();
        });
    }

    // ── Preview ──

    _showPreview(card, windows) {
        this._destroyPreview();
        const win = windows.find(w => !w.minimized && w.get_compositor_private());
        if (!win) return;

        const actor = win.get_compositor_private();
        if (!actor) return;
        const rect = win.get_frame_rect();
        if (rect.width === 0) return;

        const mon = Main.layoutManager.primaryMonitor;
        const maxW = Math.min(mon.width * 0.3, 480);
        const maxH = Math.min(mon.height * 0.35, 360);
        const s = Math.min(maxW / rect.width, maxH / rect.height, 1.0);
        const pw = rect.width * s, ph = rect.height * s;

        let clone;
        try { clone = new Clutter.Clone({ source: actor, width: pw, height: ph }); } catch (_) { return; }

        const topH = Main.panel ? Main.panel.height : 0;
        let [, cardY] = [0, 0];
        try { [, cardY] = card.get_transformed_position(); } catch (_) { return; }
        let py = Math.max(mon.y + topH + 8, Math.min(cardY, mon.y + mon.height - ph - 20));

        this._preview = new St.Widget({
            style: 'background-color: rgba(22,22,26,0.94); border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,0.55);',
            reactive: false,
        });
        this._preview.set_size(pw + 12, ph + 12);
        this._preview.set_position(mon.x + this._PANEL_W + 8, py);
        clone.set_position(6, 6);
        this._preview.add_child(clone);

        Main.layoutManager.addChrome(this._preview, { affectsInputRegion: false, trackFullscreen: false });
        this._preview.set_opacity(0);
        this._preview.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    _destroyPreview() {
        if (this._preview) {
            try {
                _nullCloneSources(this._preview);
                Main.layoutManager.removeChrome(this._preview);
                this._preview.destroy();
            } catch (_) { /* */ }
            this._preview = null;
        }
    }

    // ── Activate ──

    _activate(group) {
        if (this._animating) return;
        const { windows } = group;
        if (windows.length === 0) return;

        for (const win of windows) {
            if (win.minimized) win.unminimize();
        }
        windows[0].activate(global.get_current_time());

        if (this._settings.get_boolean('sidebar-auto-hide'))
            this._scheduleHide();
        this._scheduleRefresh();
    }

    // ── Util ──

    _kill(name) {
        if (this[name]) { GLib.source_remove(this[name]); this[name] = null; }
    }
}


// ─── Main ───────────────────────────────────────────────────────────────────

export default class StageManagerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._max = new MaximizeToWorkspace(this._settings);
        this._side = new StageSidebar(this._settings);
        this._max.enable();
        this._side.enable();
    }

    disable() {
        this._side.disable();
        this._max.disable();
        this._side = null;
        this._max = null;
        this._settings = null;
    }
}
