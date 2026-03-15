/**
 * Stage Manager - GNOME Shell Extension
 *
 * macOS Stage Manager-like window management for GNOME.
 *
 * Core concept: each GNOME workspace is a "stage". The active stage's windows
 * are visible and centered. Inactive stages appear as stacked thumbnail cards
 * in a left-side strip. Switching stages animates windows in/out with
 * smooth macOS-like transitions.
 *
 * Compatible with GNOME 45+ (ESM modules), Wayland and X11.
 */

import Meta from 'gi://Meta';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';


const MAX_STRIP_ENTRIES = 6;
const STRIP_THUMBNAIL_MAX_HEIGHT = 130;
const STACK_OFFSET_X = 4;
const STACK_OFFSET_Y = 3;
const MAX_STACKED_PREVIEWS = 3;
const HOVER_PREVIEW_SCALE = 1.8;
const HOVER_PREVIEW_DELAY = 350;


// ─── Helpers ────────────────────────────────────────────────────────────────

function _isNormalWindow(win) {
    return win &&
        !win.skip_taskbar &&
        !win.is_attached_dialog() &&
        !win.is_always_on_all_workspaces() &&
        !win.minimized;
}

function _getVisibleWindows(ws) {
    return ws.list_windows().filter(w =>
        _isNormalWindow(w) && w.get_compositor_private()
    );
}

function _safeDisconnect(obj, id) {
    try {
        if (obj && id)
            obj.disconnect(id);
    } catch (_e) {
        // Already disconnected or destroyed
    }
}


// ─── MaximizeToWorkspace ────────────────────────────────────────────────────

/**
 * Moves maximized windows to dedicated workspaces.
 * Each maximized window becomes its own "stage".
 *
 * When unmaximized, the window STAYS on its current workspace (macOS behavior).
 */
class MaximizeToWorkspace {
    constructor(settings) {
        this._settings = settings;
        this._signals = [];
        this._pendingTimeouts = [];
        this._movedWindows = new Set();
    }

    enable() {
        this._connectSignal(global.window_manager, 'size-change',
            this._onSizeChange.bind(this));
        this._connectSignal(global.window_manager, 'destroy',
            this._onWindowDestroyed.bind(this));
    }

    disable() {
        this._signals.splice(0).forEach(({ obj, id }) => _safeDisconnect(obj, id));
        this._pendingTimeouts.splice(0).forEach(id => GLib.source_remove(id));
        this._movedWindows.clear();
    }

    _connectSignal(obj, signal, callback) {
        const id = obj.connect(signal, callback);
        this._signals.push({ obj, id });
    }

    _addTimeout(delayMs, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            const idx = this._pendingTimeouts.indexOf(id);
            if (idx !== -1)
                this._pendingTimeouts.splice(idx, 1);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._pendingTimeouts.push(id);
    }

    _onSizeChange(_manager, actor, change, _oldRect) {
        if (!this._settings.get_boolean('enable-maximize-to-workspace'))
            return;

        const win = actor.meta_window;
        if (!win || win.skip_taskbar || win.is_attached_dialog())
            return;

        if (change === Meta.SizeChange.MAXIMIZE)
            this._handleMaximize(win);
        // No unmaximize handler — window stays on its workspace (user request)
    }

    _handleMaximize(win) {
        if (this._movedWindows.has(win))
            return;

        const wsManager = global.workspace_manager;
        const currentIndex = wsManager.get_active_workspace_index();

        // Check if this window is already alone on its workspace
        const currentWs = wsManager.get_workspace_by_index(currentIndex);
        const siblings = _getVisibleWindows(currentWs).filter(w => w !== win);
        if (siblings.length === 0)
            return; // Already alone, no need to move

        let targetIndex = this._findEmptyWorkspace(win);
        if (targetIndex === -1) {
            wsManager.append_new_workspace(false, global.get_current_time());
            targetIndex = wsManager.get_n_workspaces() - 1;
        }

        if (targetIndex === currentIndex)
            return;

        this._movedWindows.add(win);
        win.change_workspace_by_index(targetIndex, false);
        this._addTimeout(50, () => {
            const ws = wsManager.get_workspace_by_index(targetIndex);
            if (ws) {
                ws.activate(global.get_current_time());
                win.activate(global.get_current_time());
            }
        });
    }

    _findEmptyWorkspace(excludeWin) {
        const wsManager = global.workspace_manager;
        const n = wsManager.get_n_workspaces();
        const currentIndex = wsManager.get_active_workspace_index();

        for (let i = 0; i < n; i++) {
            if (i === currentIndex)
                continue;
            const ws = wsManager.get_workspace_by_index(i);
            const windows = ws.list_windows().filter(w =>
                w !== excludeWin && _isNormalWindow(w)
            );
            if (windows.length === 0)
                return i;
        }
        return -1;
    }

    _onWindowDestroyed(_manager, actor) {
        try {
            const win = actor.meta_window;
            if (win)
                this._movedWindows.delete(win);
        } catch (_e) {
            // Already destroyed
        }
    }
}


// ─── StageStrip ─────────────────────────────────────────────────────────────

/**
 * The left-side strip showing inactive stage thumbnails.
 *
 * Visual design modeled after macOS Stage Manager:
 * - Stacked, overlapping live thumbnails per workspace
 * - Hover shows enlarged preview
 * - Click switches workspace with smooth animation
 * - Auto-hides when not in use
 */
class StageStrip {
    constructor(settings) {
        this._settings = settings;
        this._signals = [];
        this._clones = [];
        this._panel = null;
        this._edgeZone = null;
        this._container = null;
        this._scrollView = null;
        this._refreshTimeout = null;
        this._hideTimeout = null;
        this._hoverPreview = null;
        this._hoverPreviewTimeout = null;
        this._visible = false;
        this._hovered = false;
        this._settingsSignals = [];
        this._mruWorkspaces = [];
        this._lastActiveWsIndex = -1;
        this._isAnimating = false;
    }

    enable() {
        this._buildUI();
        this._connectSignals();
        this._lastActiveWsIndex = global.workspace_manager.get_active_workspace_index();
        this._updateSidebarVisibility();
        this._refreshStrip();
    }

    disable() {
        this._clearTimeout('_refreshTimeout');
        this._clearTimeout('_hideTimeout');
        this._clearTimeout('_hoverPreviewTimeout');
        this._signals.splice(0).forEach(({ obj, id }) => _safeDisconnect(obj, id));
        this._settingsSignals.splice(0).forEach(id => {
            try { this._settings.disconnect(id); } catch (_e) { /* */ }
        });

        this._destroyHoverPreview();
        this._destroyClones();

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
        const monitor = Main.layoutManager.primaryMonitor;
        const sidebarWidth = this._settings.get_int('sidebar-width');
        const panelHeight = Main.panel ? Main.panel.height : 0;

        // Edge trigger zone — invisible hot strip at the left edge
        const edgeWidth = this._settings.get_int('edge-trigger-width');
        this._edgeZone = new St.Widget({
            reactive: true,
            track_hover: true,
            style_class: 'stage-manager-edge-zone',
        });
        this._edgeZone.set_size(edgeWidth, monitor.height - panelHeight);
        this._edgeZone.set_position(monitor.x, monitor.y + panelHeight);
        // Do NOT use trackFullscreen — we handle it ourselves to avoid flicker
        Main.layoutManager.addChrome(this._edgeZone, {
            affectsInputRegion: true,
            trackFullscreen: false,
        });
        this._edgeZone.connect('enter-event', () => {
            if (!this._isFullscreen())
                this._showPanel();
        });

        // Main panel — starts hidden off-screen to the left
        this._panel = new St.Widget({
            reactive: true,
            track_hover: true,
            style_class: 'stage-manager-panel',
            clip_to_allocation: true,
        });
        this._panel.set_size(sidebarWidth, monitor.height - panelHeight);
        this._panel.set_position(monitor.x - sidebarWidth, monitor.y + panelHeight);
        Main.layoutManager.addChrome(this._panel, {
            affectsInputRegion: true,
            trackFullscreen: false,
        });

        this._panel.connect('enter-event', () => {
            this._hovered = true;
            this._clearTimeout('_hideTimeout');
        });
        this._panel.connect('leave-event', () => {
            this._hovered = false;
            this._destroyHoverPreview();
            if (this._settings.get_boolean('sidebar-auto-hide'))
                this._scheduleHide();
        });

        // Scroll view
        this._scrollView = new St.ScrollView({
            style_class: 'stage-manager-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._scrollView.set_size(sidebarWidth - 16, monitor.height - panelHeight - 24);
        this._panel.add_child(this._scrollView);

        // Vertical container for stage entries
        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'stage-manager-container',
        });
        if (this._scrollView.set_child)
            this._scrollView.set_child(this._container);
        else
            this._scrollView.add_child(this._container);
    }

    _connectSignals() {
        this._connectSignal(global.display, 'notify::focus-window',
            () => this._scheduleRefresh());
        this._connectSignal(global.window_manager, 'map',
            () => this._scheduleRefresh());
        this._connectSignal(global.window_manager, 'destroy',
            () => this._scheduleRefresh());
        this._connectSignal(global.window_manager, 'minimize',
            () => this._scheduleRefresh());
        this._connectSignal(global.window_manager, 'unminimize',
            () => this._scheduleRefresh());
        this._connectSignal(global.window_manager, 'size-change',
            () => this._scheduleRefresh());

        this._connectSignal(global.workspace_manager, 'active-workspace-changed',
            () => this._onWorkspaceSwitched());
        this._connectSignal(global.workspace_manager, 'workspace-added',
            () => this._scheduleRefresh());
        this._connectSignal(global.workspace_manager, 'workspace-removed',
            () => this._scheduleRefresh());

        // Fullscreen changes
        this._connectSignal(global.display, 'in-fullscreen-changed',
            () => this._onFullscreenChanged());

        // Settings changes
        const sid1 = this._settings.connect('changed::enable-stage-sidebar',
            () => this._updateSidebarVisibility());
        this._settingsSignals.push(sid1);
    }

    _connectSignal(obj, signal, callback) {
        const id = obj.connect(signal, callback);
        this._signals.push({ obj, id });
    }

    // --- Fullscreen handling (no flickering) ---

    _isFullscreen() {
        try {
            const monitor = Main.layoutManager.primaryMonitor;
            return global.display.get_monitor_in_fullscreen(monitor.index);
        } catch (_e) {
            return false;
        }
    }

    _onFullscreenChanged() {
        if (this._isFullscreen()) {
            // Instantly hide — no animation to prevent flicker
            if (this._visible) {
                this._visible = false;
                const sidebarWidth = this._settings.get_int('sidebar-width');
                const monitor = Main.layoutManager.primaryMonitor;
                this._panel.set_position(monitor.x - sidebarWidth, this._panel.y);
            }
            if (this._edgeZone)
                this._edgeZone.hide();
        } else {
            // Restore edge zone after leaving fullscreen
            if (this._edgeZone && this._settings.get_boolean('enable-stage-sidebar'))
                this._edgeZone.show();
        }
    }

    // --- MRU tracking ---

    _onWorkspaceSwitched() {
        const newIndex = global.workspace_manager.get_active_workspace_index();
        if (this._lastActiveWsIndex >= 0 && this._lastActiveWsIndex !== newIndex) {
            this._mruWorkspaces = this._mruWorkspaces.filter(i => i !== this._lastActiveWsIndex);
            this._mruWorkspaces.unshift(this._lastActiveWsIndex);
        }
        this._lastActiveWsIndex = newIndex;
        this._mruWorkspaces = this._mruWorkspaces.filter(i => i !== newIndex);
        this._scheduleRefresh();
    }

    // --- Visibility ---

    _updateSidebarVisibility() {
        const enabled = this._settings.get_boolean('enable-stage-sidebar');
        if (this._edgeZone) {
            if (enabled && !this._isFullscreen())
                this._edgeZone.show();
            else
                this._edgeZone.hide();
        }
        if (!enabled && this._visible)
            this._hidePanel();
    }

    _showPanel() {
        if (this._visible || this._isAnimating)
            return;
        if (!this._settings.get_boolean('enable-stage-sidebar'))
            return;
        if (this._isFullscreen())
            return;

        this._visible = true;
        this._isAnimating = true;
        this._clearTimeout('_hideTimeout');
        this._refreshStrip();

        const monitor = Main.layoutManager.primaryMonitor;
        const duration = this._settings.get_int('animation-duration');

        this._panel.ease({
            x: monitor.x,
            duration: duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                this._isAnimating = false;
            },
        });
    }

    _hidePanel() {
        if (!this._visible || this._isAnimating)
            return;

        this._visible = false;
        this._isAnimating = true;
        this._destroyHoverPreview();
        const sidebarWidth = this._settings.get_int('sidebar-width');
        const monitor = Main.layoutManager.primaryMonitor;
        const duration = this._settings.get_int('animation-duration');

        this._panel.ease({
            x: monitor.x - sidebarWidth,
            duration: duration,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                this._isAnimating = false;
            },
        });
    }

    _scheduleHide() {
        this._clearTimeout('_hideTimeout');
        const delay = this._settings.get_int('auto-hide-delay');
        this._hideTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hideTimeout = null;
            if (!this._hovered && !this._isFullscreen())
                this._hidePanel();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleRefresh() {
        if (this._refreshTimeout)
            return;
        this._refreshTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._refreshTimeout = null;
            if (this._visible)
                this._refreshStrip();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Strip rendering ---

    _refreshStrip() {
        if (!this._settings.get_boolean('enable-stage-sidebar'))
            return;

        this._destroyClones();
        this._container.destroy_all_children();

        const activeWsIndex = global.workspace_manager.get_active_workspace_index();
        const sidebarWidth = this._settings.get_int('sidebar-width');
        const showIcons = this._settings.get_boolean('show-app-icons');

        const stages = this._getOrderedStages(activeWsIndex);
        const visibleStages = stages.slice(0, MAX_STRIP_ENTRIES);

        if (visibleStages.length === 0) {
            // Show empty state hint
            const emptyLabel = new St.Label({
                text: 'No other windows',
                style_class: 'stage-manager-empty-label',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._container.add_child(emptyLabel);
            return;
        }

        for (const stage of visibleStages) {
            const entry = this._createStageEntry(stage, sidebarWidth, showIcons);
            if (entry)
                this._container.add_child(entry);
        }
    }

    _getOrderedStages(activeWsIndex) {
        const wsManager = global.workspace_manager;
        const n = wsManager.get_n_workspaces();
        const stageMap = new Map();

        for (let i = 0; i < n; i++) {
            if (i === activeWsIndex)
                continue;

            const ws = wsManager.get_workspace_by_index(i);
            const windows = _getVisibleWindows(ws);

            if (windows.length === 0)
                continue;

            stageMap.set(i, { wsIndex: i, windows });
        }

        const ordered = [];
        for (const wsIdx of this._mruWorkspaces) {
            if (stageMap.has(wsIdx)) {
                ordered.push(stageMap.get(wsIdx));
                stageMap.delete(wsIdx);
            }
        }
        for (const [_idx, stage] of stageMap)
            ordered.push(stage);

        return ordered;
    }

    /**
     * Create a strip entry for one stage (workspace).
     * Shows stacked/overlapping thumbnails like macOS Stage Manager.
     */
    _createStageEntry(stage, sidebarWidth, showIcons) {
        const { wsIndex, windows } = stage;
        const tracker = Shell.WindowTracker.get_default();
        const thumbWidth = sidebarWidth - 36;

        // Item container
        const item = new St.BoxLayout({
            vertical: true,
            reactive: true,
            track_hover: true,
            can_focus: true,
            style_class: 'stage-manager-item',
        });

        // Stacked thumbnail area
        const stackHeight = STRIP_THUMBNAIL_MAX_HEIGHT;
        const stackWidth = thumbWidth;
        const stackContainer = new St.Widget({
            style_class: 'stage-manager-thumbnail-stack',
            clip_to_allocation: true,
        });
        stackContainer.set_size(stackWidth, stackHeight);

        const previewWindows = windows.slice(0, MAX_STACKED_PREVIEWS);

        // Render back-to-front (oldest first) so newest is on top
        for (let i = previewWindows.length - 1; i >= 0; i--) {
            const win = previewWindows[i];
            const actor = win.get_compositor_private();
            if (!actor)
                continue;

            const rect = win.get_frame_rect();
            if (rect.width === 0 || rect.height === 0)
                continue;

            const scaleX = (stackWidth - (MAX_STACKED_PREVIEWS - 1) * STACK_OFFSET_X * 2) / rect.width;
            const scaleY = (stackHeight - (MAX_STACKED_PREVIEWS - 1) * STACK_OFFSET_Y) / rect.height;
            const scale = Math.min(scaleX, scaleY, 1.0);
            const cloneW = rect.width * scale;
            const cloneH = rect.height * scale;

            let clone;
            try {
                clone = new Clutter.Clone({
                    source: actor,
                    width: cloneW,
                    height: cloneH,
                });
            } catch (_e) {
                continue;
            }

            // Center horizontally, offset each card slightly
            const offsetX = i * STACK_OFFSET_X + (stackWidth - cloneW) / 2 - ((previewWindows.length - 1) * STACK_OFFSET_X) / 2;
            const offsetY = i * STACK_OFFSET_Y;
            clone.set_position(Math.max(0, offsetX), offsetY);

            // Slight opacity reduction for background cards
            if (i > 0)
                clone.set_opacity(200 - i * 30);

            stackContainer.add_child(clone);
            this._clones.push(clone);
        }

        item.add_child(stackContainer);

        // App icons row below thumbnails
        if (showIcons) {
            const iconRow = new St.BoxLayout({
                style_class: 'stage-manager-icon-row',
                x_align: Clutter.ActorAlign.CENTER,
            });

            const seenApps = new Set();
            let labelText = '';

            for (const win of windows) {
                const app = tracker.get_window_app(win);
                if (!app)
                    continue;
                const appId = app.get_id();

                if (!seenApps.has(appId)) {
                    seenApps.add(appId);
                    if (seenApps.size <= 3) {
                        const icon = app.create_icon_texture(18);
                        iconRow.add_child(icon);
                    }
                    if (!labelText)
                        labelText = app.get_name();
                }
            }

            if (labelText) {
                if (windows.length > 1)
                    labelText += ` +${windows.length - 1}`;

                const label = new St.Label({
                    text: labelText,
                    style_class: 'stage-manager-app-label',
                    x_expand: true,
                });
                label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
                label.set_style(`max-width: ${thumbWidth - 64}px;`);
                iconRow.add_child(label);
            }

            item.add_child(iconRow);
        }

        // --- Hover preview ---
        item.connect('enter-event', () => {
            this._clearTimeout('_hoverPreviewTimeout');
            this._hoverPreviewTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_PREVIEW_DELAY, () => {
                this._hoverPreviewTimeout = null;
                this._showHoverPreview(item, windows);
                return GLib.SOURCE_REMOVE;
            });

            // Subtle scale-up on hover (macOS-like)
            item.ease({
                scale_x: 1.04,
                scale_y: 1.04,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });

        item.connect('leave-event', () => {
            this._clearTimeout('_hoverPreviewTimeout');
            this._destroyHoverPreview();

            item.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });

        // Click to switch to this stage
        item.connect('button-release-event', (_actor, event) => {
            if (event.get_button() === 1) {
                this._destroyHoverPreview();
                this._switchToStage(wsIndex);
            }
            return Clutter.EVENT_STOP;
        });

        item.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_space) {
                this._destroyHoverPreview();
                this._switchToStage(wsIndex);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Entry animation — fade in with slight slide
        item.set_opacity(0);
        item.translation_y = 8;
        item.ease({
            opacity: 255,
            translation_y: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        return item;
    }

    // --- Hover Preview ---

    _showHoverPreview(item, windows) {
        this._destroyHoverPreview();

        if (windows.length === 0)
            return;

        const win = windows[0]; // Show the top/most-recent window
        const actor = win.get_compositor_private();
        if (!actor)
            return;

        const rect = win.get_frame_rect();
        if (rect.width === 0 || rect.height === 0)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        const sidebarWidth = this._settings.get_int('sidebar-width');

        // Calculate preview size — larger than the thumbnail
        const maxPreviewW = Math.min(monitor.width * 0.35, 500);
        const maxPreviewH = Math.min(monitor.height * 0.35, 400);
        const scaleX = maxPreviewW / rect.width;
        const scaleY = maxPreviewH / rect.height;
        const scale = Math.min(scaleX, scaleY, 1.0);
        const previewW = rect.width * scale;
        const previewH = rect.height * scale;

        let clone;
        try {
            clone = new Clutter.Clone({
                source: actor,
                width: previewW,
                height: previewH,
            });
        } catch (_e) {
            return;
        }

        // Position to the right of the sidebar, vertically aligned with the item
        const panelHeight = Main.panel ? Main.panel.height : 0;
        const [, itemY] = item.get_transformed_position();
        const previewX = monitor.x + sidebarWidth + 12;
        let previewY = itemY;

        // Keep within screen bounds
        if (previewY + previewH + 20 > monitor.y + monitor.height)
            previewY = monitor.y + monitor.height - previewH - 20;
        if (previewY < monitor.y + panelHeight + 8)
            previewY = monitor.y + panelHeight + 8;

        // Container with shadow and rounded corners
        this._hoverPreview = new St.Widget({
            style_class: 'stage-manager-hover-preview',
            reactive: false,
        });
        this._hoverPreview.set_size(previewW + 16, previewH + 16);
        this._hoverPreview.set_position(previewX, previewY);

        clone.set_position(8, 8);
        this._hoverPreview.add_child(clone);
        this._clones.push(clone);

        // App name label on the preview
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (app) {
            const nameLabel = new St.Label({
                text: app.get_name(),
                style_class: 'stage-manager-preview-label',
            });
            nameLabel.set_position(12, previewH + 16 - 28);
            this._hoverPreview.add_child(nameLabel);
            // Increase container height for the label
            this._hoverPreview.set_height(previewH + 40);
        }

        Main.layoutManager.addChrome(this._hoverPreview, {
            affectsInputRegion: false,
            trackFullscreen: false,
        });

        // Fade in
        this._hoverPreview.set_opacity(0);
        this._hoverPreview.set_scale(0.92, 0.92);
        this._hoverPreview.ease({
            opacity: 255,
            scale_x: 1.0,
            scale_y: 1.0,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _destroyHoverPreview() {
        if (this._hoverPreview) {
            try {
                Main.layoutManager.removeChrome(this._hoverPreview);
                this._hoverPreview.destroy();
            } catch (_e) {
                // Already destroyed
            }
            this._hoverPreview = null;
        }
    }

    // --- Stage switching with macOS-like animation ---

    /**
     * Switch to a different stage (workspace).
     *
     * macOS animation:
     * - Current windows scale down + slide left into the sidebar strip
     * - New windows scale up + slide in from the left
     * - Smooth cubic easing with slight overshoot feel
     */
    _switchToStage(targetWsIndex) {
        const wsManager = global.workspace_manager;
        const currentWsIndex = wsManager.get_active_workspace_index();

        if (targetWsIndex === currentWsIndex || this._isAnimating)
            return;

        this._isAnimating = true;
        const animDuration = this._settings.get_int('animation-duration');
        const monitor = Main.layoutManager.primaryMonitor;
        const sidebarWidth = this._settings.get_int('sidebar-width');

        // --- Animate current workspace's windows OUT ---
        const currentWs = wsManager.get_workspace_by_index(currentWsIndex);
        if (currentWs) {
            const currentWindows = _getVisibleWindows(currentWs);

            for (let i = 0; i < currentWindows.length; i++) {
                const win = currentWindows[i];
                const actor = win.get_compositor_private();
                if (!actor)
                    continue;

                // Stagger: each window starts slightly later
                const stagger = i * 30;

                // Store original position for reset
                const origX = actor.x;

                // Slide left + scale down (into the sidebar)
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, stagger, () => {
                    actor.ease({
                        x: monitor.x - actor.width * 0.5,
                        scale_x: 0.55,
                        scale_y: 0.55,
                        opacity: 0,
                        duration: animDuration,
                        mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                        onComplete: () => {
                            try {
                                actor.set({
                                    x: origX,
                                    scale_x: 1.0,
                                    scale_y: 1.0,
                                    opacity: 255,
                                });
                            } catch (_e) {
                                // Actor may be destroyed
                            }
                        },
                    });
                    return GLib.SOURCE_REMOVE;
                });
            }
        }

        // --- Switch workspace after exit animation progresses ---
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, animDuration * 0.5, () => {
            const ws = wsManager.get_workspace_by_index(targetWsIndex);
            if (!ws) {
                this._isAnimating = false;
                return GLib.SOURCE_REMOVE;
            }

            ws.activate(global.get_current_time());

            // --- Animate incoming windows IN ---
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                const targetWs = wsManager.get_workspace_by_index(targetWsIndex);
                if (!targetWs) {
                    this._isAnimating = false;
                    return GLib.SOURCE_REMOVE;
                }

                const newWindows = _getVisibleWindows(targetWs);

                for (let i = 0; i < newWindows.length; i++) {
                    const win = newWindows[i];
                    const actor = win.get_compositor_private();
                    if (!actor)
                        continue;

                    const finalX = actor.x;
                    const finalY = actor.y;
                    const stagger = i * 40;

                    // Start from sidebar area: scaled down, to the left
                    actor.set({
                        x: monitor.x + sidebarWidth * 0.3,
                        scale_x: 0.6,
                        scale_y: 0.6,
                        opacity: 0,
                        pivot_point: new Clutter.Point({ x: 0.0, y: 0.5 }),
                    });

                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, stagger, () => {
                        actor.ease({
                            x: finalX,
                            scale_x: 1.0,
                            scale_y: 1.0,
                            opacity: 255,
                            duration: animDuration * 1.1,
                            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                        });
                        return GLib.SOURCE_REMOVE;
                    });

                    win.activate(global.get_current_time());
                }

                // Mark animation complete after all windows settle
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, animDuration * 1.2, () => {
                    this._isAnimating = false;
                    return GLib.SOURCE_REMOVE;
                });

                return GLib.SOURCE_REMOVE;
            });

            // Auto-hide sidebar after switching
            if (this._settings.get_boolean('sidebar-auto-hide'))
                this._scheduleHide();

            return GLib.SOURCE_REMOVE;
        });
    }

    _destroyClones() {
        for (const clone of this._clones) {
            try {
                clone.set_source(null);
                clone.destroy();
            } catch (_e) {
                // Already destroyed
            }
        }
        this._clones = [];
    }

    _clearTimeout(name) {
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
        this._strip = new StageStrip(this._settings);

        this._maximizer.enable();
        this._strip.enable();
    }

    disable() {
        this._strip.disable();
        this._maximizer.disable();

        this._strip = null;
        this._maximizer = null;
        this._settings = null;
    }
}
