/**
 * Stage Manager - GNOME Shell Extension
 *
 * macOS Stage Manager-like window management for GNOME.
 *
 * Behavior (matching macOS Stage Manager):
 * - PER-WORKSPACE: sidebar shows inactive apps on the CURRENT workspace
 * - The focused/active app stays centered on screen
 * - Other recently used apps appear as thumbnail stacks on the LEFT side
 * - Clicking a thumbnail brings that app to focus
 * - Apps are grouped by application
 * - Thumbnails are live Clutter clones with rounded corners
 *
 * Visual design (matching reference: magoness/Stage-Manager-Gnome):
 * - All card styling done via inline styles (not CSS classes) for reliability
 * - Transparent panel, floating rounded cards with shadows
 * - 220ms EASE_OUT_QUAD slide animations
 * - Hover: scale 1.08 up, dim other cards
 * - App icons overlapping bottom of thumbnail
 *
 * Compatible with GNOME 45+ (ESM modules), Wayland and X11.
 */

import Meta from 'gi://Meta';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';


// Layout constants (matching reference extension)
const PANEL_WIDTH = 260;
const THUMB_W = 200;
const THUMB_H = 120;
const ICON_SIZE = 30;
const ICON_OVERLAP = 10;
const MAX_GROUPS = 6;
const MAX_STACKED = 3;
const STACK_OFFSET_X = 4;
const STACK_OFFSET_Y = 4;

// Animation constants
const SLIDE_DURATION = 220;
const HIDE_DELAY = 350;
const HOVER_SCALE = 1.08;
const HOVER_DIM_OPACITY = 120;

// Edge trigger
const EDGE_WIDTH = 4;
const EDGE_HEIGHT = 300;


// ─── Helpers ────────────────────────────────────────────────────────────────

function _isNormalWindow(win) {
    if (!win)
        return false;
    if (win.get_window_type() !== Meta.WindowType.NORMAL)
        return false;
    if (win.skip_taskbar || win.is_attached_dialog())
        return false;
    if (win.is_always_on_all_workspaces())
        return false;
    return true;
}

function _getWorkspaceWindows(ws) {
    if (!ws)
        return [];
    return ws.list_windows().filter(w =>
        _isNormalWindow(w) && w.get_compositor_private()
    );
}

function _safeDisconnect(obj, id) {
    try {
        if (obj && id) obj.disconnect(id);
    } catch (_e) { /* */ }
}

/**
 * Check if a Clutter actor is still alive (not destroyed/disposed).
 */
function _isActorAlive(actor) {
    try {
        if (!actor)
            return false;
        // Accessing any property will throw if disposed
        void actor.visible;
        return true;
    } catch (_e) {
        return false;
    }
}

/**
 * Safely destroy a Clutter.Clone — handles already-disposed source actors.
 */
function _safeDestroyClone(clone) {
    if (!clone)
        return;
    try {
        // First null the source to break the reference
        // Check if clone is still alive before touching it
        if (_isActorAlive(clone)) {
            clone.set_source(null);
            clone.destroy();
        }
    } catch (_e) {
        // Already disposed — nothing to do
    }
}

/**
 * Group windows by application.
 * Returns { activeGroup, inactiveGroups[] } sorted by most recently focused.
 */
function _groupByApp(windows, focusedWindow) {
    const tracker = Shell.WindowTracker.get_default();
    const appMap = new Map();

    const sorted = [...windows].sort((a, b) =>
        (b.get_user_time() || 0) - (a.get_user_time() || 0)
    );

    for (const win of sorted) {
        const app = tracker.get_window_app(win);
        if (!app) continue;
        const id = app.get_id();
        if (!appMap.has(id))
            appMap.set(id, { app, windows: [] });
        appMap.get(id).windows.push(win);
    }

    let activeAppId = null;
    if (focusedWindow) {
        const fa = tracker.get_window_app(focusedWindow);
        if (fa) activeAppId = fa.get_id();
    }

    const inactiveGroups = [];
    for (const [appId, group] of appMap) {
        if (appId !== activeAppId)
            inactiveGroups.push(group);
    }

    return { activeGroup: activeAppId ? appMap.get(activeAppId) : null, inactiveGroups };
}


// ─── MaximizeToWorkspace ────────────────────────────────────────────────────

class MaximizeToWorkspace {
    constructor(settings) {
        this._settings = settings;
        this._signals = [];
        this._timeouts = [];
        this._movedWindows = new Set();
    }

    enable() {
        this._connect(global.window_manager, 'size-change', this._onSizeChange.bind(this));
        this._connect(global.window_manager, 'destroy', this._onDestroy.bind(this));
    }

    disable() {
        this._signals.splice(0).forEach(s => _safeDisconnect(s.obj, s.id));
        this._timeouts.splice(0).forEach(id => GLib.source_remove(id));
        this._movedWindows.clear();
    }

    _connect(obj, sig, cb) {
        this._signals.push({ obj, id: obj.connect(sig, cb) });
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.splice(this._timeouts.indexOf(id), 1);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.push(id);
    }

    _onSizeChange(_wm, actor, change) {
        if (!this._settings.get_boolean('enable-maximize-to-workspace'))
            return;
        const win = actor.meta_window;
        if (!win || !_isNormalWindow(win))
            return;
        if (change === Meta.SizeChange.MAXIMIZE)
            this._handleMaximize(win);
    }

    _handleMaximize(win) {
        if (this._movedWindows.has(win))
            return;

        const wsm = global.workspace_manager;
        const ci = wsm.get_active_workspace_index();
        const cws = wsm.get_workspace_by_index(ci);
        const siblings = _getWorkspaceWindows(cws).filter(w => w !== win);
        if (siblings.length === 0) return;

        let ti = -1;
        for (let i = 0; i < wsm.get_n_workspaces(); i++) {
            if (i === ci) continue;
            const ws = wsm.get_workspace_by_index(i);
            if (ws.list_windows().filter(w => w !== win && _isNormalWindow(w)).length === 0) {
                ti = i;
                break;
            }
        }
        if (ti === -1) {
            wsm.append_new_workspace(false, global.get_current_time());
            ti = wsm.get_n_workspaces() - 1;
        }
        if (ti === ci) return;

        this._movedWindows.add(win);
        win.change_workspace_by_index(ti, false);
        this._later(50, () => {
            const ws = wsm.get_workspace_by_index(ti);
            if (ws) {
                ws.activate(global.get_current_time());
                win.activate(global.get_current_time());
            }
        });
    }

    _onDestroy(_wm, actor) {
        try {
            const win = actor.meta_window;
            if (win) this._movedWindows.delete(win);
        } catch (_e) { /* */ }
    }
}


// ─── StageSidebar ───────────────────────────────────────────────────────────

/**
 * macOS Stage Manager sidebar using inline styles (matching reference).
 */
class StageSidebar {
    constructor(settings) {
        this._settings = settings;
        this._signals = [];
        this._settingsSignals = [];
        this._clones = [];
        this._cardContainers = []; // For hover dim effects
        this._panel = null;
        this._edgeZone = null;
        this._contentBox = null;
        this._scrollView = null;
        this._hoverPreview = null;
        this._hoverTimeout = null;
        this._refreshTimeout = null;
        this._hideTimeout = null;
        this._visible = false;
        this._hovered = false;
        this._animating = false;
    }

    enable() {
        this._buildUI();
        this._connectSignals();
        this._refresh();
    }

    disable() {
        this._clearTimer('_refreshTimeout');
        this._clearTimer('_hideTimeout');
        this._clearTimer('_hoverTimeout');
        this._signals.splice(0).forEach(s => _safeDisconnect(s.obj, s.id));
        this._settingsSignals.splice(0).forEach(id => {
            try { this._settings.disconnect(id); } catch (_e) { /* */ }
        });
        this._destroyPreview();
        this._destroyClones();
        this._cardContainers = [];
        if (this._panel) {
            Main.layoutManager.removeChrome(this._panel);
            this._panel.destroy();
            this._panel = null;
        }
        if (this._edgeZone) {
            Main.layoutManager.removeChrome(this._edgeZone);
            this._edgeZone.destroy();
            this._edgeZone = null;
        }
    }

    _buildUI() {
        const mon = Main.layoutManager.primaryMonitor;
        const panelH = Main.panel ? Main.panel.height : 0;

        // Edge trigger — thin invisible zone at left edge, vertically centered
        this._edgeZone = new St.Widget({
            reactive: true,
            track_hover: true,
            style: 'background-color: rgba(255,255,255,0.01);',
        });
        this._edgeZone.set_size(EDGE_WIDTH, EDGE_HEIGHT);
        this._edgeZone.set_position(
            mon.x,
            mon.y + panelH + (mon.height - panelH - EDGE_HEIGHT) / 2
        );
        Main.layoutManager.addChrome(this._edgeZone, {
            affectsInputRegion: true,
            trackFullscreen: false,
        });
        this._edgeZone.connect('enter-event', () => {
            if (!this._isFullscreen())
                this._show();
        });

        // Main panel — transparent background, full height
        this._panel = new St.Widget({
            reactive: true,
            track_hover: true,
            style: 'background-color: transparent;',
        });
        this._panel.set_size(PANEL_WIDTH, mon.height - panelH);
        this._panel.set_position(mon.x - PANEL_WIDTH, mon.y + panelH);

        Main.layoutManager.addChrome(this._panel, {
            affectsInputRegion: true,
            trackFullscreen: false,
        });

        this._panel.connect('enter-event', () => {
            this._hovered = true;
            this._clearTimer('_hideTimeout');
        });
        this._panel.connect('leave-event', () => {
            this._hovered = false;
            this._destroyPreview();
            this._scheduleHide();
        });

        // Scroll view inside panel
        this._scrollView = new St.ScrollView({
            style: 'padding: 0; margin: 0;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            clip_to_allocation: true,
        });
        this._scrollView.set_size(PANEL_WIDTH, mon.height - panelH);
        this._panel.add_child(this._scrollView);

        // Vertical content box
        this._contentBox = new St.BoxLayout({
            vertical: true,
            style: 'padding: 60px 0px; spacing: 16px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        if (this._scrollView.set_child)
            this._scrollView.set_child(this._contentBox);
        else
            this._scrollView.add_child(this._contentBox);

        // Custom scroll speed (matching reference: delta * 55)
        this._scrollView.connect('scroll-event', (_actor, event) => {
            const [, dy] = event.get_scroll_delta();
            const adj = this._scrollView.get_vscroll_bar().get_adjustment();
            adj.set_value(adj.get_value() + dy * 55);
            return Clutter.EVENT_STOP;
        });
    }

    _connectSignals() {
        const connect = (obj, sig, cb) => {
            this._signals.push({ obj, id: obj.connect(sig, cb) });
        };

        connect(global.display, 'notify::focus-window', () => this._scheduleRefresh());
        connect(global.window_manager, 'map', () => this._scheduleRefresh());
        connect(global.window_manager, 'destroy', () => this._scheduleRefresh());
        connect(global.window_manager, 'minimize', () => this._scheduleRefresh());
        connect(global.window_manager, 'unminimize', () => this._scheduleRefresh());
        connect(global.window_manager, 'size-change', () => this._scheduleRefresh());
        connect(global.workspace_manager, 'active-workspace-changed', () => this._scheduleRefresh());
        connect(global.display, 'in-fullscreen-changed', () => this._onFullscreenChanged());

        this._settingsSignals.push(
            this._settings.connect('changed::enable-stage-sidebar', () => {
                if (!this._settings.get_boolean('enable-stage-sidebar'))
                    this._hide();
            })
        );
    }

    // ── Fullscreen ──

    _isFullscreen() {
        try {
            return global.display.get_monitor_in_fullscreen(
                Main.layoutManager.primaryMonitor.index
            );
        } catch (_e) {
            return false;
        }
    }

    _onFullscreenChanged() {
        if (this._isFullscreen()) {
            // Instant hide — no animation prevents flicker
            if (this._visible) {
                this._visible = false;
                this._panel.set_position(
                    Main.layoutManager.primaryMonitor.x - PANEL_WIDTH,
                    this._panel.y
                );
            }
            this._edgeZone?.hide();
            this._destroyPreview();
        } else {
            if (this._settings.get_boolean('enable-stage-sidebar'))
                this._edgeZone?.show();
        }
    }

    // ── Show / Hide ──

    _show() {
        if (this._visible || this._animating) return;
        if (!this._settings.get_boolean('enable-stage-sidebar')) return;
        if (this._isFullscreen()) return;

        this._visible = true;
        this._animating = true;
        this._clearTimer('_hideTimeout');
        this._refresh();

        this._panel.ease({
            x: Main.layoutManager.primaryMonitor.x,
            duration: SLIDE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { this._animating = false; },
        });
    }

    _hide() {
        if (!this._visible || this._animating) return;

        this._visible = false;
        this._animating = true;
        this._destroyPreview();

        this._panel.ease({
            x: Main.layoutManager.primaryMonitor.x - PANEL_WIDTH,
            duration: SLIDE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { this._animating = false; },
        });
    }

    _scheduleHide() {
        this._clearTimer('_hideTimeout');
        this._hideTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
            this._hideTimeout = null;
            if (!this._hovered) this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleRefresh() {
        if (this._refreshTimeout) return;
        this._refreshTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._refreshTimeout = null;
            if (this._visible) this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Render ──

    _refresh() {
        if (!this._settings.get_boolean('enable-stage-sidebar')) return;

        this._destroyClones();
        this._cardContainers = [];
        this._contentBox.destroy_all_children();

        const activeWs = global.workspace_manager.get_active_workspace();
        const allWindows = _getWorkspaceWindows(activeWs);
        const focusedWin = global.display.get_focus_window();

        // Also include minimized windows
        const minimized = activeWs.list_windows().filter(w =>
            _isNormalWindow(w) && w.minimized && w.get_compositor_private()
        );
        const unique = [...new Set([...allWindows, ...minimized])];

        const { inactiveGroups } = _groupByApp(unique, focusedWin);
        const groups = inactiveGroups.slice(0, MAX_GROUPS);

        if (groups.length === 0) return;

        for (const group of groups) {
            const container = this._createCard(group);
            if (container) {
                this._contentBox.add_child(container);
                this._cardContainers.push(container);
            }
        }
    }

    /**
     * Create a single app card matching the reference design:
     * - Rounded thumbnail (border-radius: 16px) with live clone
     * - App icon centered below, overlapping the thumbnail slightly
     * - Hover: scale 1.08, dim other cards
     * - Click: activate that app group
     */
    _createCard(group) {
        const { app, windows } = group;

        // Outer container — holds thumbnail + icon, transparent
        const container = new St.BoxLayout({
            vertical: true,
            reactive: true,
            track_hover: true,
            can_focus: true,
            style: 'padding: 0px;',
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Thumbnail wrapper — rounded corners, clipping, shadow
        const thumbWrapper = new St.Widget({
            style: `
                border-radius: 16px;
                background-color: rgba(30, 30, 30, 0.6);
            `,
            clip_to_allocation: true,
        });

        const previewWins = windows.slice(0, MAX_STACKED);

        if (previewWins.length === 1) {
            // Single window — simple centered clone
            thumbWrapper.set_size(THUMB_W, THUMB_H);
            const clone = this._createClone(previewWins[0], THUMB_W, THUMB_H);
            if (clone) {
                thumbWrapper.add_child(clone);
            }
        } else {
            // Multiple windows — stacked with offset
            const stackH = THUMB_H + (previewWins.length - 1) * STACK_OFFSET_Y;
            thumbWrapper.set_size(THUMB_W, stackH);

            for (let i = previewWins.length - 1; i >= 0; i--) {
                const innerW = THUMB_W - (MAX_STACKED - 1) * STACK_OFFSET_X * 2;
                const clone = this._createClone(previewWins[i], innerW, THUMB_H);
                if (!clone) continue;

                const ox = i * STACK_OFFSET_X + (THUMB_W - innerW) / 2 -
                    ((previewWins.length - 1) * STACK_OFFSET_X) / 2;
                const oy = i * STACK_OFFSET_Y;
                clone.set_position(Math.max(0, ox), oy);

                if (i > 0)
                    clone.set_opacity(200 - i * 30);

                thumbWrapper.add_child(clone);
            }
        }

        container.add_child(thumbWrapper);

        // Dim overlay — for hover dimming of non-hovered cards
        const dimOverlay = new St.Widget({
            style: 'background-color: rgba(0,0,0,0.45); border-radius: 16px;',
        });
        dimOverlay.set_size(THUMB_W, thumbWrapper.height);
        dimOverlay.set_position(0, 0);
        dimOverlay.set_opacity(0);
        thumbWrapper.add_child(dimOverlay);
        container._dimOverlay = dimOverlay;

        // App icon below thumbnail (centered, slightly overlapping)
        if (app) {
            const iconBox = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                style: `margin-top: -${ICON_OVERLAP}px; padding: 0;`,
            });

            const iconBin = new St.Bin({
                style: `
                    background-color: rgba(40, 40, 42, 0.9);
                    border-radius: ${ICON_SIZE / 2 + 4}px;
                    padding: 4px;
                    border: 1px solid rgba(255,255,255,0.1);
                `,
            });
            const icon = app.create_icon_texture(ICON_SIZE);
            iconBin.set_child(icon);
            iconBox.add_child(iconBin);
            container.add_child(iconBox);
        }

        // ── Hover effects (matching reference) ──

        container.connect('enter-event', () => {
            // Scale up hovered card
            container.ease({
                scale_x: HOVER_SCALE,
                scale_y: HOVER_SCALE,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            // Dim other cards
            for (const c of this._cardContainers) {
                if (c === container) {
                    c._dimOverlay?.ease({ opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                } else {
                    c.ease({
                        scale_x: 0.95,
                        scale_y: 0.95,
                        duration: 180,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    c._dimOverlay?.ease({
                        opacity: HOVER_DIM_OPACITY,
                        duration: 180,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
            }

            // Schedule hover preview
            this._clearTimer('_hoverTimeout');
            this._hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                this._hoverTimeout = null;
                this._showPreview(container, windows);
                return GLib.SOURCE_REMOVE;
            });
        });

        container.connect('leave-event', () => {
            this._clearTimer('_hoverTimeout');
            this._destroyPreview();

            // Reset all cards
            for (const c of this._cardContainers) {
                c.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                c._dimOverlay?.ease({ opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            }
        });

        // ── Click ──

        container.connect('button-release-event', (_a, event) => {
            if (event.get_button() === 1) {
                this._destroyPreview();
                this._switchTo(group);
            }
            return Clutter.EVENT_STOP;
        });

        container.connect('key-press-event', (_a, event) => {
            const s = event.get_key_symbol();
            if (s === Clutter.KEY_Return || s === Clutter.KEY_space) {
                this._destroyPreview();
                this._switchTo(group);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return container;
    }

    /**
     * Create a safely-managed Clutter.Clone for a window.
     * Returns null if the actor is unavailable.
     */
    _createClone(win, width, height) {
        const actor = win.get_compositor_private();
        if (!_isActorAlive(actor))
            return null;

        const rect = win.get_frame_rect();
        if (rect.width === 0 || rect.height === 0)
            return null;

        const sx = width / rect.width;
        const sy = height / rect.height;
        const scale = Math.min(sx, sy, 1.0);
        const cw = rect.width * scale;
        const ch = rect.height * scale;

        let clone;
        try {
            clone = new Clutter.Clone({
                source: actor,
                width: cw,
                height: ch,
            });
        } catch (_e) {
            return null;
        }

        // Center within the given area
        clone.set_position(
            Math.max(0, (width - cw) / 2),
            Math.max(0, (height - ch) / 2)
        );

        this._clones.push(clone);

        // Watch for source actor destruction — disconnect clone before it crashes
        const destroyId = actor.connect('destroy', () => {
            try {
                if (_isActorAlive(clone)) {
                    clone.set_source(null);
                }
            } catch (_e) { /* */ }
        });

        // Store so we can disconnect later
        clone._sourceDestroyId = destroyId;
        clone._sourceActor = actor;

        return clone;
    }

    // ── Hover preview ──

    _showPreview(card, windows) {
        this._destroyPreview();
        if (windows.length === 0) return;

        const win = windows[0];
        const actor = win.get_compositor_private();
        if (!_isActorAlive(actor)) return;

        const rect = win.get_frame_rect();
        if (rect.width === 0 || rect.height === 0) return;

        const mon = Main.layoutManager.primaryMonitor;
        const maxW = Math.min(mon.width * 0.35, 520);
        const maxH = Math.min(mon.height * 0.4, 400);
        const s = Math.min(maxW / rect.width, maxH / rect.height, 1.0);
        const pw = rect.width * s;
        const ph = rect.height * s;

        let clone;
        try {
            clone = new Clutter.Clone({ source: actor, width: pw, height: ph });
        } catch (_e) {
            return;
        }

        const panelH = Main.panel ? Main.panel.height : 0;
        const [, cardY] = card.get_transformed_position();
        const previewX = mon.x + PANEL_WIDTH + 12;
        let previewY = cardY;
        if (previewY + ph + 30 > mon.y + mon.height)
            previewY = mon.y + mon.height - ph - 30;
        if (previewY < mon.y + panelH + 8)
            previewY = mon.y + panelH + 8;

        this._hoverPreview = new St.Widget({
            style: `
                background-color: rgba(25, 25, 28, 0.92);
                border-radius: 16px;
                border: 1px solid rgba(255,255,255,0.08);
                box-shadow: 0 10px 40px rgba(0,0,0,0.55);
            `,
            reactive: false,
        });
        this._hoverPreview.set_size(pw + 16, ph + 16);
        this._hoverPreview.set_position(previewX, previewY);

        clone.set_position(8, 8);
        this._hoverPreview.add_child(clone);
        this._clones.push(clone);

        // Watch for source destruction
        const did = actor.connect('destroy', () => {
            try {
                if (_isActorAlive(clone))
                    clone.set_source(null);
            } catch (_e) { /* */ }
        });
        clone._sourceDestroyId = did;
        clone._sourceActor = actor;

        Main.layoutManager.addChrome(this._hoverPreview, {
            affectsInputRegion: false,
            trackFullscreen: false,
        });

        // Animate in
        this._hoverPreview.set_opacity(0);
        this._hoverPreview.set_scale(0.92, 0.92);
        this._hoverPreview.set_pivot_point(0, 0.5);
        this._hoverPreview.ease({
            opacity: 255,
            scale_x: 1.0,
            scale_y: 1.0,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _destroyPreview() {
        if (this._hoverPreview) {
            try {
                Main.layoutManager.removeChrome(this._hoverPreview);
                this._hoverPreview.destroy();
            } catch (_e) { /* */ }
            this._hoverPreview = null;
        }
    }

    // ── Stage switching ──

    _switchTo(group) {
        if (this._animating) return;

        const { windows } = group;
        if (windows.length === 0) return;

        this._animating = true;
        const mon = Main.layoutManager.primaryMonitor;

        // Activate windows with slide-in animation
        for (let i = windows.length - 1; i >= 0; i--) {
            const win = windows[i];
            if (win.minimized) win.unminimize();

            const actor = win.get_compositor_private();
            if (!_isActorAlive(actor)) continue;

            const targetX = actor.x;

            // Start from left / scaled down
            try {
                actor.set({
                    x: mon.x - actor.width * 0.3,
                    scale_x: 0.75,
                    scale_y: 0.75,
                    opacity: 60,
                    pivot_point: new Clutter.Point({ x: 0.0, y: 0.5 }),
                });

                const delay = (windows.length - 1 - i) * 35;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    if (!_isActorAlive(actor)) return GLib.SOURCE_REMOVE;
                    actor.ease({
                        x: targetX,
                        scale_x: 1.0,
                        scale_y: 1.0,
                        opacity: 255,
                        duration: SLIDE_DURATION * 1.3,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    return GLib.SOURCE_REMOVE;
                });
            } catch (_e) { /* */ }
        }

        windows[0].activate(global.get_current_time());
        this._scheduleHide();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDE_DURATION * 1.5, () => {
            this._animating = false;
            this._scheduleRefresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Cleanup ──

    _destroyClones() {
        for (const clone of this._clones) {
            // Disconnect source actor destroy signal first
            if (clone._sourceActor && clone._sourceDestroyId) {
                try {
                    clone._sourceActor.disconnect(clone._sourceDestroyId);
                } catch (_e) { /* */ }
                clone._sourceActor = null;
                clone._sourceDestroyId = null;
            }
            _safeDestroyClone(clone);
        }
        this._clones = [];
    }

    _clearTimer(name) {
        if (this[name]) {
            GLib.source_remove(this[name]);
            this[name] = null;
        }
    }
}


// ─── Main Extension ─────────────────────────────────────────────────────────

export default class StageManagerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._maximizer = new MaximizeToWorkspace(this._settings);
        this._sidebar = new StageSidebar(this._settings);
        this._maximizer.enable();
        this._sidebar.enable();
    }

    disable() {
        this._sidebar.disable();
        this._maximizer.disable();
        this._sidebar = null;
        this._maximizer = null;
        this._settings = null;
    }
}
