/**
 * Stage Manager - GNOME Shell Extension
 *
 * macOS-style Stage Manager for GNOME.
 * Groups windows into "stages" — only one group visible at a time,
 * others shown as sidebar thumbnail cards.
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


const THUMB_W = 170;
const THUMB_H = 110;
const ICON_SIZE = 22;
const MAX_GROUPS = 8;
const BELL_SIGMA = 0.9;   // tight: only 1-2 neighbors affected
const MAX_STACK = 3;
const STACK_H = 14;   // horizontal spread between stacked layers
const STACK_V = 4;    // slight vertical offset per layer


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

function _bellCurve(dist, sigma) {
    return Math.exp(-(dist * dist) / (2 * sigma * sigma));
}

/** Group windows by app (for 'apps' sidebar mode). */
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
        this._swapTimer = null;
        this._visible = false;
        this._hovered = false;
        this._animating = false;
        this._hoveredIdx = -1;

        // Group tracking (for 'groups' mode)
        this._groups = [];
        this._activeGroupId = null;
        this._nextGid = 0;
        this._swapping = false;
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
        this._initGroups();
        if (!this._settings.get_boolean('sidebar-auto-hide'))
            this._show();
    }

    disable() {
        this._kill('_refreshTimer');
        this._kill('_hideTimer');
        this._kill('_hoverTimer');
        this._kill('_swapTimer');
        this._sigs.splice(0).forEach(s => { try { s.o.disconnect(s.i); } catch (_) { /* */ } });
        this._setSigs.splice(0).forEach(id => { try { this._settings.disconnect(id); } catch (_) { /* */ } });
        this._destroyPreview();
        this._safeDestroyContent();
        this._cards = [];
        this._groups = [];
        this._activeGroupId = null;
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

    // ── Build UI ──

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

        // Panel container — fully transparent, cards have their own backgrounds
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
            style: 'padding: 40px 0px; spacing: 10px;',
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

    // ── Wire signals ──

    _wire() {
        const sig = (o, s, cb) => { this._sigs.push({ o, i: o.connect(s, cb) }); };

        sig(global.window_manager, 'map', (_wm, actor) => {
            const win = actor?.meta_window;
            if (win) this._onWindowMap(win);
        });
        sig(global.window_manager, 'destroy', (_wm, actor) => {
            const win = actor?.meta_window;
            if (win) this._onWindowDestroy(win);
        });
        sig(global.window_manager, 'minimize', (_wm, actor) => {
            const win = actor?.meta_window;
            if (win) this._onWindowMinimize(win);
        });
        sig(global.window_manager, 'unminimize', (_wm, actor) => {
            const win = actor?.meta_window;
            if (win) this._onWindowUnminimize(win);
        });

        sig(global.display, 'notify::focus-window', () => this._scheduleRefresh());
        sig(global.workspace_manager, 'active-workspace-changed', () => this._initGroups());
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
        this._setSigs.push(this._settings.connect('changed::show-group-count', () => {
            if (this._visible) this._refresh();
        }));
        this._setSigs.push(this._settings.connect('changed::card-base-scale', () => {
            if (this._visible) this._refresh();
        }));
        this._setSigs.push(this._settings.connect('changed::perspective-angle', () => {
            if (this._visible) this._refresh();
        }));
    }

    // ── Group management (for 'groups' mode) ─────────────────────────────

    _initGroups() {
        const ws = global.workspace_manager.get_active_workspace();
        const allWins = ws.list_windows().filter(w => _isNormal(w));

        this._groups = [];
        this._nextGid = 0;
        this._activeGroupId = null;
        this._swapping = false;

        const visible = allWins.filter(w => !w.minimized);
        if (visible.length > 0) {
            const g = { id: this._nextGid++, windows: new Set(visible) };
            this._groups.push(g);
            this._activeGroupId = g.id;
        }

        const tracker = Shell.WindowTracker.get_default();
        const byApp = new Map();
        for (const win of allWins.filter(w => w.minimized)) {
            const app = tracker.get_window_app(win);
            const key = app ? app.get_id() : `_anon_${win.get_id()}`;
            if (!byApp.has(key)) byApp.set(key, []);
            byApp.get(key).push(win);
        }
        for (const [, wins] of byApp) {
            this._groups.push({ id: this._nextGid++, windows: new Set(wins) });
        }

        if (this._visible) this._refresh();
    }

    _getActiveGroup() {
        return this._groups.find(g => g.id === this._activeGroupId) || null;
    }

    _getInactiveGroups() {
        return this._groups.filter(g => g.id !== this._activeGroupId && g.windows.size > 0);
    }

    _findGroupForWindow(win) {
        return this._groups.find(g => g.windows.has(win)) || null;
    }

    _cleanupEmptyGroups() {
        this._groups = this._groups.filter(g => g.windows.size > 0);
        if (this._activeGroupId !== null && !this._groups.find(g => g.id === this._activeGroupId)) {
            this._activeGroupId = null;
        }
    }

    _onWindowMinimize(win) {
        if (this._swapping || !_isNormal(win)) return;
        if (this._settings.get_string('sidebar-mode') === 'groups') {
            const group = this._findGroupForWindow(win);
            if (group && group.id === this._activeGroupId) {
                group.windows.delete(win);
                this._groups.push({ id: this._nextGid++, windows: new Set([win]) });
                this._cleanupEmptyGroups();
            }
        }
        this._scheduleRefresh();
    }

    _onWindowUnminimize(win) {
        if (this._swapping || !_isNormal(win)) return;
        if (this._settings.get_string('sidebar-mode') === 'groups') {
            const group = this._findGroupForWindow(win);
            if (group && group.id !== this._activeGroupId) {
                group.windows.delete(win);
            }
            let active = this._getActiveGroup();
            if (!active) {
                active = { id: this._nextGid++, windows: new Set() };
                this._groups.push(active);
                this._activeGroupId = active.id;
            }
            active.windows.add(win);
            this._cleanupEmptyGroups();
        }
        this._scheduleRefresh();
    }

    _onWindowMap(win) {
        if (!_isNormal(win)) return;
        if (this._settings.get_string('sidebar-mode') === 'groups') {
            let active = this._getActiveGroup();
            if (!active) {
                active = { id: this._nextGid++, windows: new Set() };
                this._groups.push(active);
                this._activeGroupId = active.id;
            }
            active.windows.add(win);
        }
        this._scheduleRefresh();
    }

    _onWindowDestroy(win) {
        for (const group of this._groups) {
            group.windows.delete(win);
        }
        this._cleanupEmptyGroups();
        this._scheduleRefresh();
    }

    _swapToGroup(targetGroup) {
        if (this._swapping) return;
        if (targetGroup.id === this._activeGroupId) return;

        this._swapping = true;
        this._destroyPreview();

        const activeGroup = this._getActiveGroup();

        if (activeGroup) {
            for (const win of activeGroup.windows) {
                if (!win.minimized) {
                    try { win.minimize(); } catch (_) { /* */ }
                }
            }
        }

        for (const win of targetGroup.windows) {
            if (win.minimized) {
                try { win.unminimize(); } catch (_) { /* */ }
            }
        }

        const sorted = [...targetGroup.windows].sort((a, b) =>
            (b.get_user_time() || 0) - (a.get_user_time() || 0)
        );
        if (sorted.length > 0) {
            sorted[0].activate(global.get_current_time());
        }

        this._activeGroupId = targetGroup.id;

        this._kill('_swapTimer');
        this._swapTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._swapTimer = null;
            this._swapping = false;
            return GLib.SOURCE_REMOVE;
        });

        this._hovered = false;
        this._kill('_refreshTimer');
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._refreshTimer = null;
            if (this._visible) this._refresh();
            return GLib.SOURCE_REMOVE;
        });

        if (this._settings.get_boolean('sidebar-auto-hide'))
            this._scheduleHide();
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

    // ── Render ──────────────────────────────────────────────────────────

    _refresh() {
        if (!this._settings.get_boolean('enable-stage-sidebar')) return;

        this._cards = [];
        this._hoveredIdx = -1;
        this._safeDestroyContent();

        const mode = this._settings.get_string('sidebar-mode');

        if (mode === 'workspaces')
            this._refreshWorkspaces();
        else if (mode === 'apps')
            this._refreshApps();
        else
            this._refreshGroups();

        this._animateCardsEntrance();
    }

    _refreshGroups() {
        const inactive = this._getInactiveGroups().slice(0, MAX_GROUPS);
        for (const group of inactive) {
            try {
                const card = this._makeGroupCard(group);
                if (card) { this._box.add_child(card); this._cards.push(card); }
            } catch (e) { console.error(`[StageManager] group card: ${e.message}`); }
        }
    }

    _refreshApps() {
        const activeWs = global.workspace_manager.get_active_workspace();
        const focusedWin = global.display.get_focus_window();
        const groups = _groupByApp(activeWs, focusedWin).slice(0, MAX_GROUPS);
        for (const group of groups) {
            try {
                const card = this._makeAppCard(group);
                if (card) { this._box.add_child(card); this._cards.push(card); }
            } catch (e) { console.error(`[StageManager] app card: ${e.message}`); }
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
                if (card) { this._box.add_child(card); this._cards.push(card); }
            } catch (e) { console.error(`[StageManager] ws card: ${e.message}`); }
        }
    }

    _safeDestroyContent() {
        if (!this._box) return;
        try { _nullCloneSources(this._box); this._box.destroy_all_children(); } catch (_) { /* */ }
    }

    // ── Entrance animation ──

    _animateCardsEntrance() {
        const base = this._BASE_SCALE;
        const angle = this._PERSP_ANGLE;

        for (let i = 0; i < this._cards.length; i++) {
            const card = this._cards[i];

            // Start invisible, shifted down
            card.set_opacity(0);
            card.translation_y = 24;
            card.set_scale(base * 0.82, base * 0.82);

            // Perspective on the thumb (not the card)
            const thumb = card._thumb;
            if (thumb) {
                thumb.set_pivot_point(0.0, 0.5);
                thumb.rotation_angle_y = angle;
            }

            card.ease({
                opacity: 190,
                translation_y: 0,
                scale_x: base,
                scale_y: base,
                duration: 300,
                delay: i * 55,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    // ── Card builders ───────────────────────────────────────────────────

    /**
     * Create a card wrapper with a frosted-glass pill background.
     * The card itself has the visual bg — the panel is fully transparent.
     */
    _wrapCard() {
        return new St.BoxLayout({
            vertical: true, reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 8px 14px; border-radius: 16px; ' +
                   'background-color: rgba(28,28,34,0.55);',
        });
    }

    _makeGroupCard(group) {
        const windows = [...group.windows].sort((a, b) =>
            (b.get_user_time() || 0) - (a.get_user_time() || 0)
        );
        if (windows.length === 0) return null;

        const card = this._wrapCard();
        const thumb = this._makeStackedThumb(windows);
        card.add_child(thumb);
        card._thumb = thumb;

        if (this._settings.get_boolean('show-app-icons')) {
            const tracker = Shell.WindowTracker.get_default();
            const seenApps = new Set();
            const iconBox = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                style: 'margin-top: 5px; spacing: 4px;',
            });
            for (const win of windows) {
                const app = tracker.get_window_app(win);
                if (app && !seenApps.has(app.get_id())) {
                    seenApps.add(app.get_id());
                    iconBox.add_child(app.create_icon_texture(ICON_SIZE));
                }
            }
            if (seenApps.size > 0) card.add_child(iconBox);
        }

        // Scale pivot at center of card
        card.set_pivot_point(0.5, 0.5);

        const idx = this._cards.length;
        this._wireCardEvents(card, thumb, windows, idx);

        card.connect('button-release-event', () => {
            this._destroyPreview();
            this._swapToGroup(group);
            return Clutter.EVENT_STOP;
        });

        return card;
    }

    _makeAppCard(group) {
        const { app, windows } = group;
        const card = this._wrapCard();
        const thumb = this._makeStackedThumb(windows);
        card.add_child(thumb);
        card._thumb = thumb;

        if (app && this._settings.get_boolean('show-app-icons')) {
            const iconBox = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                style: 'margin-top: 5px;',
            });
            iconBox.add_child(app.create_icon_texture(ICON_SIZE));
            card.add_child(iconBox);
        }

        card.set_pivot_point(0.5, 0.5);
        const idx = this._cards.length;
        this._wireCardEvents(card, thumb, windows, idx);

        card.connect('button-release-event', () => {
            this._destroyPreview();
            this._activateApp(group);
            return Clutter.EVENT_STOP;
        });

        return card;
    }

    _activateApp(group) {
        if (this._animating) return;
        const { windows } = group;
        if (windows.length === 0) return;
        for (const win of windows) { if (win.minimized) win.unminimize(); }
        windows[0].activate(global.get_current_time());
        if (this._settings.get_boolean('sidebar-auto-hide')) this._scheduleHide();
        this._scheduleRefresh();
    }

    _makeStackedThumb(windows) {
        const n = Math.min(windows.length, MAX_STACK);
        const totalH = (n - 1) * STACK_H;
        const totalV = (n - 1) * STACK_V;
        const container = new St.Widget({ reactive: false });
        container.set_size(THUMB_W + totalH, THUMB_H + totalV);

        // Render back → front: back cards fan out to the right
        for (let i = n - 1; i >= 0; i--) {
            const win = windows[i];
            const x = i * STACK_H;    // back cards further right
            const y = i * STACK_V;    // slight downward offset
            const isFront = (i === 0);
            const layerOpacity = isFront ? 255 : Math.max(140, 210 - i * 30);
            const bgAlpha = isFront ? 0.6 : (0.45 - i * 0.05);
            const radius = isFront ? 12 : 10;

            const layer = new St.Widget({
                reactive: false,
                style: `border-radius: ${radius}px; background-color: rgba(30,30,34,${bgAlpha});`,
                opacity: layerOpacity,
            });
            layer.set_size(THUMB_W, THUMB_H);
            layer.set_position(x, y);

            const actor = win.get_compositor_private?.();
            if (actor) {
                try {
                    const clone = new Clutter.Clone({
                        source: actor, reactive: false,
                        width: THUMB_W, height: THUMB_H,
                    });
                    layer.add_child(clone);
                } catch (_) { this._addIconFallback(layer, win); }
            } else {
                this._addIconFallback(layer, win);
            }

            container.add_child(layer);
        }

        const children = container.get_children();
        container._frontLayer = children.length > 0 ? children[children.length - 1] : null;

        // Count badge — bottom-left of front layer
        if (windows.length > 1 && this._settings.get_boolean('show-group-count')) {
            const badge = new St.Label({
                text: `${windows.length}`,
                style: 'background-color: rgba(100,120,220,0.85); color: white; ' +
                       'border-radius: 9px; padding: 1px 7px; font-size: 10px; font-weight: bold;',
                reactive: false,
            });
            badge.set_position(4, THUMB_H - 20);
            container.add_child(badge);
        }

        return container;
    }

    _addIconFallback(layer, win) {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (app) {
            const icon = app.create_icon_texture(48);
            icon.set_position((THUMB_W - 48) / 2, (THUMB_H - 48) / 2);
            layer.add_child(icon);
        }
    }

    _makeWorkspaceCard(ws, wins, wsIndex, isCurrent) {
        const card = this._wrapCard();
        const thumb = this._makeStackedThumb(wins);
        card.add_child(thumb);
        card._thumb = thumb;

        const labelStyle = isCurrent
            ? 'margin-top: 6px; color: rgba(140,180,255,0.9); font-size: 11px; font-weight: bold;'
            : 'margin-top: 6px; color: rgba(255,255,255,0.6); font-size: 11px;';
        card.add_child(new St.Label({
            text: isCurrent ? `Workspace ${wsIndex + 1} (current)` : `Workspace ${wsIndex + 1}`,
            x_align: Clutter.ActorAlign.CENTER, style: labelStyle,
        }));
        if (wins.length > 0) {
            card.add_child(new St.Label({
                text: `${wins.length} window${wins.length > 1 ? 's' : ''}`,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'color: rgba(255,255,255,0.35); font-size: 10px;',
            }));
        }

        card.set_pivot_point(0.5, 0.5);
        const idx = this._cards.length;
        this._wireCardEvents(card, thumb, wins, idx);
        card.connect('button-release-event', () => {
            this._destroyPreview();
            if (!isCurrent) ws.activate(global.get_current_time());
            if (this._settings.get_boolean('sidebar-auto-hide')) this._scheduleHide();
            this._scheduleRefresh();
            return Clutter.EVENT_STOP;
        });
        return card;
    }

    // ── Bell curve scaling ──────────────────────────────────────────────

    /**
     * Reset all cards to resting state.
     * Scale + opacity on card, perspective rotation on THUMB only.
     */
    _resetAllCardScales() {
        const base = this._BASE_SCALE;
        const angle = this._PERSP_ANGLE;
        for (const card of this._cards) {
            card.remove_all_transitions();
            card.set_scale(base, base);
            card.set_opacity(190);
            // Perspective on thumb — consistent direction for all cards
            const thumb = card._thumb;
            if (thumb) {
                thumb.remove_all_transitions();
                thumb.rotation_angle_y = angle;
            }
        }
    }

    /**
     * Bell curve: hovered card scales to 1.0 and thumb goes flat.
     * Only 1-2 neighbors are affected (tight sigma).
     * Scale/opacity on card, perspective on thumb.
     */
    _applyBellCurve(hoveredIdx) {
        const base = this._BASE_SCALE;
        const angle = this._PERSP_ANGLE;

        for (let i = 0; i < this._cards.length; i++) {
            const dist = Math.abs(i - hoveredIdx);
            const factor = _bellCurve(dist, BELL_SIGMA);
            const s = base + (1.0 - base) * factor;
            const op = Math.round(190 + 65 * factor);
            // Thumb perspective: hovered = flat, far = full angle
            const rot = angle * (1.0 - factor);

            this._cards[i].ease({
                scale_x: s, scale_y: s,
                opacity: op,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            const thumb = this._cards[i]._thumb;
            if (thumb) {
                thumb.ease({
                    rotation_angle_y: rot,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }
    }

    // ── Card events ─────────────────────────────────────────────────────

    _wireCardEvents(card, thumb, windows, cardIdx) {
        card.connect('enter-event', () => {
            this._hovered = true;
            this._kill('_hideTimer');
            this._hoveredIdx = cardIdx;

            this._applyBellCurve(cardIdx);

            // Glow on front layer
            const front = thumb._frontLayer;
            if (front) {
                front.set_style(
                    'border-radius: 12px; background-color: rgba(50,50,58,0.75); ' +
                    'box-shadow: 0 4px 20px rgba(120,140,255,0.18);'
                );
            }
            // Highlight card pill
            card.set_style(
                'padding: 8px 14px; border-radius: 16px; ' +
                'background-color: rgba(45,45,55,0.7);'
            );

            // Preview after short delay
            this._kill('_hoverTimer');
            this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                this._hoverTimer = null;
                this._showPreview(card, windows);
                return GLib.SOURCE_REMOVE;
            });
        });

        card.connect('leave-event', () => {
            this._hoveredIdx = -1;

            // Reset all cards
            const base = this._BASE_SCALE;
            const angle = this._PERSP_ANGLE;
            for (const c of this._cards) {
                c.ease({
                    scale_x: base, scale_y: base,
                    opacity: 190,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                const t = c._thumb;
                if (t) {
                    t.ease({
                        rotation_angle_y: angle,
                        duration: 200,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
            }

            // Remove glow
            const front = thumb._frontLayer;
            if (front) {
                front.set_style('border-radius: 12px; background-color: rgba(30,30,34,0.6);');
            }
            // Reset card pill
            card.set_style(
                'padding: 8px 14px; border-radius: 16px; ' +
                'background-color: rgba(28,28,34,0.55);'
            );

            this._kill('_hoverTimer');
            this._destroyPreview();
        });
    }

    // ── Preview ─────────────────────────────────────────────────────────

    /**
     * Show a larger preview showing ALL windows in the group, tiled vertically.
     * Falls back to icon grid if no compositor actors available.
     */
    _showPreview(card, windows) {
        this._destroyPreview();

        const mon = Main.layoutManager.primaryMonitor;
        const topH = Main.panel ? Main.panel.height : 0;
        let [, cardY] = [0, 0];
        try { [, cardY] = card.get_transformed_position(); } catch (_) { return; }

        // Collect windows that have compositor actors (cloneable)
        const cloneable = windows.filter(w => {
            try { return !!w.get_compositor_private(); } catch (_) { return false; }
        });

        if (cloneable.length === 0) {
            this._showIconPreview(windows, cardY);
            return;
        }

        // Layout: tile all windows vertically
        const maxPreviewW = Math.min(mon.width * 0.32, 500);
        const padding = 8;
        const gap = 6;
        const maxPerWin = cloneable.length;
        const clones = [];
        let maxCloneW = 0;
        let totalH = padding * 2;

        for (const w of cloneable.slice(0, 4)) {
            const actor = w.get_compositor_private();
            if (!actor) continue;
            const rect = w.get_frame_rect();
            if (rect.width === 0) continue;

            const maxWinH = (mon.height * 0.45 - padding * 2 - gap * (Math.min(maxPerWin, 4) - 1)) / Math.min(maxPerWin, 4);
            const s = Math.min((maxPreviewW - padding * 2) / rect.width, maxWinH / rect.height, 1.0);
            const cw = rect.width * s;
            const ch = rect.height * s;

            try {
                const clone = new Clutter.Clone({ source: actor, width: cw, height: ch });
                clones.push({ clone, w: cw, h: ch });
                totalH += ch + gap;
                maxCloneW = Math.max(maxCloneW, cw);
            } catch (_) { /* skip */ }
        }

        if (clones.length === 0) {
            this._showIconPreview(windows, cardY);
            return;
        }

        totalH -= gap; // remove trailing gap
        const previewW = maxCloneW + padding * 2;
        const previewH = totalH;

        let py = Math.max(mon.y + topH + 8, Math.min(cardY, mon.y + mon.height - previewH - 20));

        this._preview = new St.Widget({
            style: 'background-color: rgba(22,22,26,0.94); border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,0.55);',
            reactive: false,
        });
        this._preview.set_size(previewW, previewH);
        this._preview.set_position(mon.x + this._PANEL_W + 8, py);

        let yOff = padding;
        for (const { clone, w, h } of clones) {
            clone.set_position(padding + (maxCloneW - w) / 2, yOff);
            this._preview.add_child(clone);
            yOff += h + gap;
        }

        Main.layoutManager.addChrome(this._preview, { affectsInputRegion: false, trackFullscreen: false });
        this._preview.set_opacity(0);
        this._preview.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    /**
     * Fallback preview: app icons + names when clones aren't available.
     */
    _showIconPreview(windows, cardY) {
        const tracker = Shell.WindowTracker.get_default();
        const mon = Main.layoutManager.primaryMonitor;
        const topH = Main.panel ? Main.panel.height : 0;

        const previewW = 220;
        const previewH = 160;

        this._preview = new St.Widget({
            style: 'background-color: rgba(22,22,26,0.94); border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,0.55);',
            reactive: false,
        });
        this._preview.set_size(previewW, previewH);
        let py = Math.max(mon.y + topH + 8, Math.min(cardY, mon.y + mon.height - previewH - 20));
        this._preview.set_position(mon.x + this._PANEL_W + 8, py);

        const seenApps = new Map();
        for (const w of windows) {
            const app = tracker.get_window_app(w);
            if (app && !seenApps.has(app.get_id())) seenApps.set(app.get_id(), app);
        }

        let yOff = 14;
        const names = [...seenApps.values()].map(a => a.get_name()).join(', ');
        const title = new St.Label({
            text: names || 'Application',
            style: 'color: rgba(255,255,255,0.85); font-size: 12px; font-weight: bold;',
        });
        title.set_position(14, yOff);
        title.set_width(previewW - 28);
        this._preview.add_child(title);
        yOff += 28;

        let xOff = 14;
        for (const [, app] of seenApps) {
            const icon = app.create_icon_texture(48);
            icon.set_position(xOff, yOff);
            this._preview.add_child(icon);
            xOff += 56;
            if (xOff + 48 > previewW) { xOff = 14; yOff += 56; }
        }

        this._preview.add_child(new St.Label({
            text: `${windows.length} window${windows.length > 1 ? 's' : ''} (minimized)`,
            style: 'color: rgba(255,255,255,0.4); font-size: 10px;',
            x: 14, y: previewH - 24,
        }));

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
