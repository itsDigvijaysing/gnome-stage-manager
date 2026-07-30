/**
 * Stage Manager — macOS-style window grouping sidebar for GNOME Shell (46+, ESM).
 */

import Meta from 'gi://Meta';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';


// Stage coordinates are PHYSICAL pixels, so every logical length below (and
// every user-facing "pixel" setting) is multiplied by scale_factor before use.
const THUMB_W = 170;   // reference width: sets the fan-out ratio and fallback aspect
const THUMB_H = 110;
const ICON_SIZE = 22;
const MAX_GROUPS = 8;
const BELL_SIGMA = 0.9;   // tight: only 1-2 neighbors affected
const MAX_STACK = 3;
const STACK_H = 14;   // horizontal fan-out at THUMB_W; scaled proportionally
const STACK_V = 4;    // vertical offset at THUMB_W; scaled proportionally
// Safety floor only; must stay below the narrowest fit the settings allow (~57px)
// or it fights _thumbSize()'s own fit.
const MIN_THUMB_W = 48;
// Must match .stage-card's horizontal padding in stylesheet.css, or cards overflow.
const CARD_PAD_X = 14;
const CARD_MARGIN = 8;    // breathing room between the card and the panel edges
const SCROLL_STEP = 55;   // wheel travel per notch
const PERSP_HEADROOM = 0.18;   // extra width to budget for a rotated card's projection
// Clamp window shape so an extreme window (sliver, ultrawide) can't produce an absurd card.
const THUMB_ASPECT_MIN = 0.7;
const THUMB_ASPECT_MAX = 2.4;
const CARD_REST_OPACITY = 190;    // resting card opacity
const CARD_HOVER_OPACITY = 255;   // fully opaque at the centre of the bell curve
// Fallback stills are full-resolution textures, so only a handful are kept.
const MAX_SNAPSHOTS = 8;
const KEYBIND_NAME = 'toggle-sidebar';


// ─── Helpers ────────────────────────────────────────────────────────────────

function _isNormal(win) {
    if (!win) return false;
    if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
    if (win.skip_taskbar || win.is_attached_dialog()) return false;
    if (win.is_always_on_all_workspaces()) return false;
    return true;
}

function _nullCloneSources(actor) {
    if (!actor) return;
    if (actor instanceof Clutter.Clone)
        actor.set_source(null);
    for (const child of actor.get_children?.() ?? [])
        _nullCloneSources(child);
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
        this._sigSources = new Set();
        this._timers = [];
        this._moved = new Set();
        // win → origin Meta.Workspace, never an index — mutter reaps empty
        // workspaces, so a stored index can end up pointing at the wrong one.
        this._origin = new Map();
    }

    enable() {
        this._sig(global.window_manager, 'size-change', this._onSize.bind(this));
        this._sig(global.window_manager, 'destroy', (_wm, actor) => {
            const w = actor?.meta_window;
            if (w) {
                this._moved.delete(w);
                this._origin.delete(w);
            }
        });
    }

    disable() {
        this._sigSources.forEach(o => o.disconnectObject(this));
        this._sigSources.clear();
        this._timers.splice(0).forEach(id => GLib.source_remove(id));
        this._moved.clear();
        this._origin.clear();
    }

    _sig(o, s, cb) {
        o.connectObject(s, cb, this);
        this._sigSources.add(o);
    }

    /** Drop a fired timer from tracking without disturbing the others. */
    _untrackTimer(id) {
        const i = this._timers.indexOf(id);
        if (i >= 0) this._timers.splice(i, 1);
    }

    /** True while `ws` is still one of the live workspaces. */
    _workspaceAlive(ws) {
        if (!ws) return false;
        const wsm = global.workspace_manager;
        for (let i = 0; i < wsm.get_n_workspaces(); i++) {
            if (wsm.get_workspace_by_index(i) === ws) return true;
        }
        return false;
    }

    _onSize(_wm, actor, change) {
        const win = actor.meta_window;
        if (!win || !_isNormal(win)) return;

        if (change === Meta.SizeChange.MAXIMIZE) {
            // Only the outbound move is opt-in — a window already parked must
            // still be able to return even if the setting was since disabled.
            if (!this._settings.get_boolean('enable-maximize-to-workspace')) return;
            this._handleMaximize(win);
        } else if (change === Meta.SizeChange.UNMAXIMIZE) {
            this._handleUnmaximize(win);
        }
    }

    _handleMaximize(win) {
        if (this._moved.has(win)) return;

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
        this._origin.set(win, cws);
        win.change_workspace_by_index(ti, false);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._untrackTimer(id);
            const ws = wsm.get_workspace_by_index(ti);
            if (ws) { ws.activate(global.get_current_time()); win.activate(global.get_current_time()); }
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(id);
    }

    _handleUnmaximize(win) {
        const originWs = this._origin.get(win);
        if (!originWs) return;

        this._origin.delete(win);
        this._moved.delete(win);

        // The origin may be gone entirely (user closed all its windows and
        // mutter reaped it), in which case leave the window where it is.
        if (!this._workspaceAlive(originWs)) return;
        if (win.get_workspace() === originWs) return;

        win.change_workspace(originWs);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._untrackTimer(id);
            if (this._workspaceAlive(originWs)) {
                originWs.activate(global.get_current_time());
                win.activate(global.get_current_time());
            }
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(id);
    }
}


// ─── StageSidebar ───────────────────────────────────────────────────────────

class StageSidebar {
    constructor(settings) {
        this._settings = settings;
        this._sigSources = new Set();      // persistent signal sources (cleared in disable)
        this._cardSigSources = new Set();  // per-card signal sources (cleared each refresh)
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
        this._hoveredIdx = -1;
        this._keybindingAdded = false;

        // Cached HiDPI / theme state — recomputed on relevant signals.
        this._scaleFactor = 1;
        this._themeClass = '';     // '' (dark default) or 'light'

        // Group tracking ('groups' mode) — every group carries its workspace, so
        // a stage never pulls in or minimizes windows from another workspace.
        this._groups = [];          // [{ id, ws, windows: Set }]
        this._activeIds = new Map();   // Meta.Workspace → active group id
        this._nextGid = 0;

        // Windows whose next minimize/unminimize was caused by us during a swap
        // (consumed by the handlers, so it's never mistaken for the user's own action).
        this._expectMinimize = new Set();
        this._expectUnminimize = new Set();

        this._signature = null;     // fingerprint of what is currently rendered

        // Chrome registration state — the panel is re-registered when its
        // struts setting changes (see _applyChrome).
        this._chromeAdded = false;
        this._chromeStruts = false;

        // win → cached still, used only when the live actor is unusable at draw
        // time. Insertion-ordered, capped at MAX_SNAPSHOTS (oldest evicted).
        this._snapshots = new Map();
    }

    // ── Signal & timer tracking ─────────────────────────────────────────
    // Every signal MUST flow through _sig()/_cardSig() so it can be disconnected
    // in disable() (EGO-L-003) — both route through connectObject(), tracked
    // per-source so disable() can call disconnectObject(this) on each source.

    _sig(obj, signal, cb) {
        obj.connectObject(signal, cb, this);
        this._sigSources.add(obj);
    }

    _cardSig(obj, signal, cb) {
        obj.connectObject(signal, cb, this);
        this._cardSigSources.add(obj);
    }

    _disconnectCardSigs() {
        this._cardSigSources.forEach(o => o.disconnectObject(this));
        this._cardSigSources.clear();
    }

    // ── Settings getters ──
    // User "pixel" settings are logical units (like CSS px) — scaled to stage
    // (physical) coordinates here.
    get _PANEL_W() { return this._settings.get_int('sidebar-width') * this._scaleFactor; }
    get _SLIDE_MS() { return this._settings.get_int('animation-duration'); }
    get _HIDE_DELAY_MS() { return this._settings.get_int('auto-hide-delay'); }
    get _EDGE_W() { return this._settings.get_int('edge-trigger-width') * this._scaleFactor; }
    get _BASE_SCALE() { return this._settings.get_int('card-base-scale') / 100.0; }
    get _PERSP_ANGLE() { return this._settings.get_int('perspective-angle'); }

    enable() {
        this._recomputeScale();
        this._recomputeThemeClass();
        this._build();
        this._wire();
        this._initGroups();
        this._addKeybinding();
        if (!this._settings.get_boolean('sidebar-auto-hide'))
            this._show();
        this._syncEdge();
    }

    disable() {
        // Timers first — must run before any actor destroy so timer callbacks
        // can't fire against half-destroyed state.
        this._killRefreshTimer();
        this._killHideTimer();
        this._killHoverTimer();
        this._killSwapTimer();
        // Keybinding before signals so the wm doesn't keep a stale handler.
        this._removeKeybinding();
        // Signals next (EGO-L-003).
        this._sigSources.forEach(o => o.disconnectObject(this));
        this._sigSources.clear();
        this._disconnectCardSigs();
        // Then preview + card content (cards live inside _box).
        this._destroyPreview();
        this._safeDestroyContent();
        this._cards = [];
        this._groups = [];
        this._activeIds.clear();
        this._expectMinimize.clear();
        this._expectUnminimize.clear();
        this._snapshots.clear();
        this._signature = null;
        // Explicit destroy for every actor created in _build() (EGO-L-002).
        // Destroy children before parents so set_child(null) calls don't dangle.
        if (this._box) {
            this._box.destroy();
            this._box = null;
        }
        if (this._scroll) {
            this._scroll.destroy();
            this._scroll = null;
        }
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

        // Edge trigger — reactive by necessity, kept hidden except when needed
        // (_syncEdge), or it eats clicks/resize-grabs along the screen edge.
        this._edge = new St.Widget({
            reactive: true,
            style: 'background-color: transparent;',
        });
        this._edge.set_size(edgeW, panelH);
        this._edge.set_position(mon.x, mon.y + topH);
        Main.layoutManager.addChrome(this._edge, { trackFullscreen: false });
        this._sig(this._edge, 'enter-event', () => {
            if (!this._fullscreen()) this._show();
        });

        // reactive MUST stay false (here and on the scroll view) — a reactive
        // full-height panel would swallow every click/scroll in its column.
        this._panel = new St.Widget({
            reactive: false,
            style: 'background-color: transparent;',
        });
        this._panel.set_size(panelW, panelH);
        this._panel.set_position(mon.x - panelW, mon.y + topH);
        this._visible = false;
        this._applyChrome();

        // ScrollView → BoxLayout
        this._scroll = new St.ScrollView({
            reactive: false,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            // EXTERNAL, not NEVER — NEVER gives the adjustment no range, so
            // scrolling could never move it. EXTERNAL keeps the range, just hides the bar.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            clip_to_allocation: true,
        });
        this._scroll.set_size(panelW, panelH);
        this._panel.add_child(this._scroll);

        const sf = this._scaleFactor;
        // Unlike the panel and scroll view, the card column IS reactive — the
        // smallest region that fixes scrolling without swallowing clicks elsewhere.
        this._box = new St.BoxLayout({
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            style: `padding: ${Math.round(24 * sf)}px 0px; spacing: ${Math.round(10 * sf)}px;`,
        });
        this._setVertical(this._box);
        this._scroll.set_child(this._box);

        // Bound on the column, on each card (_wireCardEvents) and on the scroll
        // view — never rely on one alone, since the scroll view isn't reactive.
        this._sig(this._box, 'scroll-event', (_actor, event) => this._onScrollEvent(event));
        this._sig(this._scroll, 'scroll-event', (_actor, event) => this._onScrollEvent(event));

        // Fires for events bubbling up from the reactive cards.
        this._sig(this._panel, 'enter-event', () => {
            this._hovered = true;
            this._killHideTimer();
            return Clutter.EVENT_PROPAGATE;
        });
        this._sig(this._panel, 'leave-event', (_actor, event) => {
            // Ignore a leave when the pointer is only moving to another actor
            // inside the panel, or the preview/card scales tear down mid-gesture.
            if (this._insidePanel(this._crossingRelated(event)))
                return Clutter.EVENT_PROPAGATE;

            this._hovered = false;
            this._hoveredIdx = -1;
            this._killHoverTimer();
            this._resetAllCardScales();
            this._destroyPreview();
            if (this._settings.get_boolean('sidebar-auto-hide'))
                this._scheduleHide();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /** Whether the sidebar should claim a strut right now. Struts are
     *  geometry-based and can't animate, so only true while genuinely parked on screen. */
    _wantStruts() {
        return this._settings.get_boolean('sidebar-reserve-space') &&
               this._settings.get_boolean('enable-stage-sidebar') &&
               !this._settings.get_boolean('sidebar-auto-hide') &&
               this._visible && !this._fullscreen();
    }

    /** Re-register the panel's chrome with the struts setting it needs. addChrome()
     *  throws if already tracked, so untrack first; skip when the answer is unchanged. */
    _applyChrome() {
        if (!this._panel) return;
        const wanted = this._wantStruts();
        if (this._chromeAdded && this._chromeStruts === wanted) return;

        if (this._chromeAdded)
            Main.layoutManager.removeChrome(this._panel);
        Main.layoutManager.addChrome(this._panel, {
            trackFullscreen: false,
            affectsStruts: wanted,
        });
        this._chromeAdded = true;
        this._chromeStruts = wanted;
    }

    /** Scroll the card list. Bound on the scroll view and every card; EVENT_STOP
     *  from whichever fires first stops the other from moving the adjustment twice. */
    _onScrollEvent(event) {
        const adj = this._scroll?.vadjustment;
        if (!adj) return Clutter.EVENT_PROPAGATE;

        // Smooth-scroll devices (touchpads, hi-res mice) report a delta; legacy
        // mice only report a discrete direction. get_scroll_delta() is only
        // meaningful for SMOOTH, so branch on the direction instead of probing
        // it — the shape GNOME's own scroll handlers use.
        let dy = 0;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.SMOOTH)
            [, dy] = event.get_scroll_delta();
        else if (dir === Clutter.ScrollDirection.UP)
            dy = -1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            dy = 1;
        // A smooth-scroll gesture ends with a zero-delta event; let it through
        // instead of swallowing it.
        if (dy === 0) return Clutter.EVENT_PROPAGATE;

        const step = SCROLL_STEP * this._scaleFactor;
        const max = Math.max(0, adj.upper - adj.page_size);
        adj.value = Math.max(0, Math.min(max, adj.value + dy * step));
        return Clutter.EVENT_STOP;
    }

    /** The actor a crossing event is travelling to/from, if the event exposes one. */
    _crossingRelated(event) {
        return event?.get_related() ?? null;
    }

    _insidePanel(actor) {
        if (!actor || !this._panel) return false;
        return actor === this._panel || this._panel.contains(actor);
    }

    /** `vertical` is deprecated in favor of `orientation` on GNOME 48+ — set
     *  whichever the running shell offers. */
    _setVertical(box) {
        if ('orientation' in St.BoxLayout.prototype)
            box.orientation = Clutter.Orientation.VERTICAL;
        else
            box.vertical = true;
    }

    /** Show the edge trigger only while actually needed (off screen, enabled,
     *  not fullscreen) — otherwise it steals input along the screen edge. */
    _syncEdge() {
        if (!this._edge) return;
        const wanted = this._settings.get_boolean('enable-stage-sidebar') &&
                       !this._visible && !this._fullscreen();
        if (wanted) this._edge.show();
        else this._edge.hide();
    }

    // ── Layout rebuild (monitor / scale / size setting change) ───────────

    _rebuildLayout() {
        if (!this._panel || !this._edge || !this._scroll) return;
        const mon = Main.layoutManager.primaryMonitor;
        const topH = Main.panel ? Main.panel.height : 0;
        const panelW = this._PANEL_W;
        const edgeW = this._EDGE_W;
        const panelH = mon.height - topH;

        this._edge.set_size(edgeW, panelH);
        this._edge.set_position(mon.x, mon.y + topH);

        // Drop any in-flight slide first — it's aimed at the old width and
        // would otherwise leave the panel at a stale offset.
        this._panel.remove_all_transitions();
        this._panel.set_size(panelW, panelH);
        const x = this._visible ? mon.x : mon.x - panelW;
        this._panel.set_position(x, mon.y + topH);
        this._scroll.set_size(panelW, panelH);
        this._syncEdge();

        if (this._visible) this._refresh();
    }

    _recomputeScale() {
        this._scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    }

    _recomputeThemeClass() {
        // GNOME 47+ exposes color_scheme; PREFER_LIGHT is the light variant.
        const cs = St.Settings.get().color_scheme;
        this._themeClass = (cs === St.SystemColorScheme.PREFER_LIGHT) ? 'light' : '';
    }

    // ── Wire signals ──

    _wire() {
        this._sig(global.window_manager, 'map', (_wm, actor) => {
            const win = actor?.meta_window;
            if (win) this._onWindowMap(win);
        });
        this._sig(global.window_manager, 'destroy', (_wm, actor) => {
            const win = actor?.meta_window;
            if (win) this._onWindowDestroy(win);
        });
        this._sig(global.window_manager, 'minimize', (_wm, actor) => {
            const win = actor?.meta_window;
            if (win) this._onWindowMinimize(win);
        });
        this._sig(global.window_manager, 'unminimize', (_wm, actor) => {
            const win = actor?.meta_window;
            if (win) this._onWindowUnminimize(win);
        });

        this._sig(global.display, 'notify::focus-window', () => this._scheduleRefresh());
        this._sig(global.workspace_manager, 'active-workspace-changed', () => this._initGroups());
        this._sig(global.workspace_manager, 'workspace-added', () => this._scheduleRefresh());
        this._sig(global.workspace_manager, 'workspace-removed', () => {
            // A dead workspace's stages would otherwise keep their windows alive forever.
            this._pruneDeadWorkspaces();
            this._scheduleRefresh();
        });
        this._sig(global.display, 'in-fullscreen-changed', () => this._onFullscreen());
        this._sig(Main.layoutManager, 'monitors-changed', () => this._rebuildLayout());

        const themeCtx = St.ThemeContext.get_for_stage(global.stage);
        this._sig(themeCtx, 'notify::scale-factor', () => {
            this._recomputeScale();
            this._rebuildLayout();
        });

        this._sig(St.Settings.get(), 'notify::color-scheme', () => {
            this._recomputeThemeClass();
            if (this._visible) this._refresh();
        });

        this._sig(this._settings, 'changed::enable-stage-sidebar', () => {
            if (!this._settings.get_boolean('enable-stage-sidebar')) {
                if (this._visible) this._hide();
            } else if (!this._settings.get_boolean('sidebar-auto-hide')) {
                this._show();
            }
            this._syncEdge();
            this._applyChrome();
        });
        this._sig(this._settings, 'changed::sidebar-reserve-space', () => this._applyChrome());
        this._sig(this._settings, 'changed::sidebar-mode', () => {
            this._initGroups();
            if (this._visible) this._refresh();
        });

        this._sig(this._settings, 'changed::sidebar-width', () => this._rebuildLayout());
        this._sig(this._settings, 'changed::edge-trigger-width', () => this._rebuildLayout());
        this._sig(this._settings, 'changed::sidebar-auto-hide', () => {
            if (this._settings.get_boolean('sidebar-auto-hide')) {
                if (!this._hovered) this._scheduleHide();
            } else {
                this._show();
            }
            this._applyChrome();
        });
        this._sig(this._settings, 'changed::show-app-icons', () => {
            if (this._visible) this._refresh();
        });
        this._sig(this._settings, 'changed::show-group-count', () => {
            if (this._visible) this._refresh();
        });
        this._sig(this._settings, 'changed::card-base-scale', () => {
            if (this._visible) this._refresh();
        });
        this._sig(this._settings, 'changed::perspective-angle', () => {
            if (this._visible) this._refresh();
        });
    }

    // ── Group management (for 'groups' mode) ─────────────────────────────

    _activeWs() {
        return global.workspace_manager.get_active_workspace();
    }

    /** Groups belonging to one workspace. */
    _groupsFor(ws) {
        return this._groups.filter(g => g.ws === ws);
    }

    /** Sync stages for the active workspace. Seeded from window state only the
     *  FIRST time a workspace becomes active, or switching back collapsed the user's arrangement. */
    _initGroups() {
        this._pruneDeadWorkspaces();
        this._reapMovedWindows();
        const ws = this._activeWs();
        if (!ws) return;

        if (this._groupsFor(ws).length === 0)
            this._seedGroups(ws);
        else
            this._adoptStrayWindows(ws);

        if (this._visible) this._refresh();
    }

    _seedGroups(ws) {
        const allWins = ws.list_windows().filter(w => _isNormal(w));

        const visible = allWins.filter(w => !w.minimized);
        if (visible.length > 0) {
            const g = { id: this._nextGid++, ws, windows: new Set(visible) };
            this._groups.push(g);
            this._activeIds.set(ws, g.id);
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
            this._groups.push({ id: this._nextGid++, ws, windows: new Set(wins) });
        }
    }

    /** Fold windows that appeared on `ws` while it was off screen into its stages. */
    _adoptStrayWindows(ws) {
        const known = new Set();
        for (const g of this._groupsFor(ws)) {
            for (const win of g.windows) known.add(win);
        }

        const strays = ws.list_windows().filter(w => _isNormal(w) && !known.has(w));
        if (strays.length === 0) return;

        const visible = strays.filter(w => !w.minimized);
        if (visible.length > 0) {
            const active = this._ensureActiveGroup(ws);
            for (const win of visible) active.windows.add(win);
        }
        for (const win of strays.filter(w => w.minimized))
            this._groups.push({ id: this._nextGid++, ws, windows: new Set([win]) });
    }

    /** Forget stages whose workspace no longer exists. */
    _pruneDeadWorkspaces() {
        const wsm = global.workspace_manager;
        const live = new Set();
        for (let i = 0; i < wsm.get_n_workspaces(); i++)
            live.add(wsm.get_workspace_by_index(i));

        this._groups = this._groups.filter(g => live.has(g.ws));
        for (const ws of [...this._activeIds.keys()]) {
            if (!live.has(ws)) this._activeIds.delete(ws);
        }
    }

    _getActiveGroup(ws = this._activeWs()) {
        const id = this._activeIds.get(ws);
        if (id === undefined) return null;
        return this._groups.find(g => g.id === id) || null;
    }

    _ensureActiveGroup(ws = this._activeWs()) {
        let active = this._getActiveGroup(ws);
        if (!active) {
            active = { id: this._nextGid++, ws, windows: new Set() };
            this._groups.push(active);
            this._activeIds.set(ws, active.id);
        }
        return active;
    }

    _getInactiveGroups() {
        const ws = this._activeWs();
        const activeId = this._activeIds.get(ws);
        return this._groups.filter(g =>
            g.ws === ws && g.id !== activeId && this._groupWindows(g).length > 0);
    }

    /** Windows of `group` still on its workspace, most recent first — a window
     *  dragged elsewhere is skipped rather than minimized/cloned from the wrong stage. */
    _groupWindows(group) {
        return [...group.windows]
            .filter(w => w.get_workspace() === group.ws)
            .sort((a, b) => (b.get_user_time() || 0) - (a.get_user_time() || 0));
    }

    _findGroupForWindow(win) {
        return this._groups.find(g => g.windows.has(win)) || null;
    }

    _isActiveGroup(group) {
        return !!group && this._activeIds.get(group.ws) === group.id;
    }

    _workspaceOf(win) {
        return win.get_workspace();
    }

    /** Drop `win` from a stage whose workspace it no longer lives on — otherwise
     *  it ends up a member of two stages at once. */
    _evictIfMoved(win) {
        const group = this._findGroupForWindow(win);
        if (!group) return;
        const ws = this._workspaceOf(win);
        if (ws && group.ws !== ws) {
            group.windows.delete(win);
            this._cleanupEmptyGroups();
        }
    }

    /** Sweep every stage for windows that have since changed workspace. */
    _reapMovedWindows() {
        for (const group of this._groups) {
            for (const win of [...group.windows]) {
                if (this._workspaceOf(win) !== group.ws) group.windows.delete(win);
            }
        }
        this._cleanupEmptyGroups();
    }

    _cleanupEmptyGroups() {
        this._groups = this._groups.filter(g => g.windows.size > 0);
        for (const [ws, id] of [...this._activeIds]) {
            if (!this._groups.some(g => g.id === id)) this._activeIds.delete(ws);
        }
    }

    _onWindowMinimize(win) {
        if (!_isNormal(win)) return;
        // Our own swap minimized this one — consume it, it is not the user
        // parking a window. (The swap already captured its snapshot.)
        if (this._expectMinimize.delete(win)) return;

        // Grab a still before the actor goes quiet — best-effort, the icon
        // fallback covers it if the compositor already unmapped the window.
        this._captureSnapshot(win);

        if (this._settings.get_string('sidebar-mode') === 'groups') {
            const ws = this._workspaceOf(win);
            this._evictIfMoved(win);
            const group = this._findGroupForWindow(win);
            if (!group) {
                // Held by no stage — park it as its own stage on the workspace it lives on.
                if (ws) this._groups.push({ id: this._nextGid++, ws, windows: new Set([win]) });
            } else if (this._isActiveGroup(group)) {
                group.windows.delete(win);
                this._groups.push({ id: this._nextGid++, ws: group.ws, windows: new Set([win]) });
                this._cleanupEmptyGroups();
            }
        }
        this._scheduleRefresh();
    }

    _onWindowUnminimize(win) {
        if (!_isNormal(win)) return;
        // The window is live again, so its cached still is now stale.
        this._dropSnapshot(win);
        if (this._expectUnminimize.delete(win)) return;

        if (this._settings.get_string('sidebar-mode') === 'groups') {
            const ws = this._workspaceOf(win);
            if (!ws) return;
            this._evictIfMoved(win);
            const group = this._findGroupForWindow(win);
            if (group && !this._isActiveGroup(group)) group.windows.delete(win);
            this._ensureActiveGroup(ws).windows.add(win);
            this._cleanupEmptyGroups();
        }
        this._scheduleRefresh();
    }

    _onWindowMap(win) {
        if (!_isNormal(win)) return;
        if (this._settings.get_string('sidebar-mode') === 'groups') {
            // A window opening on another workspace belongs to THAT workspace's
            // stages, not the one currently on screen.
            const ws = win.get_workspace();
            if (ws) this._ensureActiveGroup(ws).windows.add(win);
        }
        this._scheduleRefresh();
    }

    _onWindowDestroy(win) {
        this._expectMinimize.delete(win);
        this._expectUnminimize.delete(win);
        this._dropSnapshot(win);
        for (const group of this._groups) {
            group.windows.delete(win);
        }
        this._cleanupEmptyGroups();
        this._scheduleRefresh();
    }

    _swapToGroup(targetGroup) {
        const ws = this._activeWs();
        if (!targetGroup || targetGroup.ws !== ws) return;
        if (targetGroup.id === this._activeIds.get(ws)) return;

        this._destroyPreview();

        const activeGroup = this._getActiveGroup(ws);
        if (activeGroup) {
            for (const win of this._groupWindows(activeGroup)) {
                if (!win.minimized) {
                    // Freeze how it looks now: once minimized its actor stops
                    // producing frames and a live clone would go blank.
                    this._captureSnapshot(win);
                    this._expectMinimize.add(win);
                    win.minimize();
                }
            }
        }

        const targetWins = this._groupWindows(targetGroup);
        for (const win of targetWins) {
            if (win.minimized) {
                this._expectUnminimize.add(win);
                win.unminimize();
            }
        }

        if (targetWins.length > 0) {
            targetWins[0].activate(global.get_current_time());
        }

        this._activeIds.set(ws, targetGroup.id);

        // Safety net only: a compositor that refuses a minimize would otherwise
        // leave a stale expectation behind that swallows the user's next one.
        this._killSwapTimer();
        this._swapTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._swapTimer = null;
            this._expectMinimize.clear();
            this._expectUnminimize.clear();
            return GLib.SOURCE_REMOVE;
        });

        this._hovered = false;
        // Reuses the single _refreshTimer slot — killing it first means a swap
        // refresh and a debounced refresh can never both be queued.
        this._killRefreshTimer();
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
        // primaryMonitor is briefly null while monitors are being reconfigured.
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon) return false;
        return global.display.get_monitor_in_fullscreen(mon.index);
    }

    _onFullscreen() {
        if (this._fullscreen()) {
            this._destroyPreview();
            if (this._visible) {
                this._visible = false;
                if (this._panel) {
                    this._panel.remove_all_transitions();
                    this._panel.set_position(
                        Main.layoutManager.primaryMonitor.x - this._PANEL_W, this._panel.y);
                }
            }
            this._syncEdge();
            this._applyChrome();
        } else {
            this._syncEdge();
            // An always-visible sidebar has to come back on its own; it used to
            // stay hidden until the user happened to brush the screen edge.
            if (this._settings.get_boolean('enable-stage-sidebar') &&
                !this._settings.get_boolean('sidebar-auto-hide'))
                this._show();
        }
    }

    // ── Keybinding ──

    _addKeybinding() {
        Main.wm.addKeybinding(
            KEYBIND_NAME,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggleVisible(),
        );
        this._keybindingAdded = true;
    }

    _removeKeybinding() {
        if (!this._keybindingAdded) return;
        Main.wm.removeKeybinding(KEYBIND_NAME);
        this._keybindingAdded = false;
    }

    _toggleVisible() {
        if (!this._settings.get_boolean('enable-stage-sidebar')) return;
        if (this._visible) this._hide();
        else this._show();
    }

    // ── Show / Hide ──

    // `_visible` alone gates entry — no separate `_animating` flag. Gating on
    // one meant a pointer returning mid-slide-out was dropped with nothing to retry.
    _show() {
        if (this._visible || !this._panel) return;
        if (!this._settings.get_boolean('enable-stage-sidebar') || this._fullscreen()) return;

        this._visible = true;
        this._killHideTimer();
        this._refresh();
        this._syncEdge();

        this._panel.remove_all_transitions();
        this._panel.ease({
            x: Main.layoutManager.primaryMonitor.x,
            duration: this._SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            // Claimed only once settled — mid-slide would resize every window on every frame.
            onComplete: () => this._applyChrome(),
        });
    }

    _hide() {
        if (!this._visible || !this._panel) return;

        this._visible = false;
        this._destroyPreview();
        this._syncEdge();
        // Give the space back before moving, so windows reflow once rather than
        // tracking the panel across the screen.
        this._applyChrome();
        // Drop the fingerprint so the next reveal replays the entrance animation
        // instead of showing stale cards.
        this._signature = null;

        this._panel.remove_all_transitions();
        this._panel.ease({
            x: Main.layoutManager.primaryMonitor.x - this._PANEL_W,
            duration: this._SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _scheduleHide() {
        this._killHideTimer();
        this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._HIDE_DELAY_MS, () => {
            this._hideTimer = null;
            if (!this._hovered) this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleRefresh() {
        // EGO-L-007: must remove any in-flight timer before re-arming. Inlined
        // (not via _killRefreshTimer) — shexli wants the remove textually adjacent.
        if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._refreshTimer = null; }
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._refreshTimer = null;
            if (this._visible && !this._hovered) this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Render ──────────────────────────────────────────────────────────

    _refresh() {
        if (!this._settings.get_boolean('enable-stage-sidebar') || !this._box) return;

        // Nothing to redraw? Then don't — every rebuild recreates a window clone
        // per thumbnail, and this runs on every focus change.
        const signature = this._renderSignature();
        if (signature === this._signature) return;
        this._signature = signature;

        // Cards about to be destroyed may be under the pointer with no leave-event
        // coming — tear down hover state here or `_hovered` sticks true forever.
        this._killHoverTimer();
        this._destroyPreview();
        this._hovered = false;

        this._disconnectCardSigs();
        this._cards = [];
        this._hoveredIdx = -1;
        this._safeDestroyContent();

        const mode = this._settings.get_string('sidebar-mode');

        if (mode === 'workspaces')
            this._refreshWorkspaces();
        else if (mode === 'apps')
            this._refreshApps();
        else if (mode === 'all-windows')
            this._refreshAllWindows();
        else
            this._refreshGroups();

        this._animateCardsEntrance();
    }

    /** Fingerprint of everything _refresh() would draw, so a refresh is skipped
     *  when the result would be pixel-identical. */
    _renderSignature() {
        const mode = this._settings.get_string('sidebar-mode');
        const parts = [
            mode, this._scaleFactor, this._themeClass, this._PANEL_W,
            this._BASE_SCALE, this._PERSP_ANGLE,
            this._settings.get_boolean('show-app-icons') ? 1 : 0,
            this._settings.get_boolean('show-group-count') ? 1 : 0,
        ];

        // Window ids alone aren't enough — a card's shape follows its front
        // window, so a resize must count too (bucketed to skip per-pixel rebuilds).
        const ids = wins => {
            const shape = wins.length > 0
                ? Math.round((this._windowAspect(wins[0]) ?? 0) * 20)
                : 0;
            return `${wins.map(w => w.get_id()).join('.')}@${shape}`;
        };

        if (mode === 'workspaces') {
            const wsm = global.workspace_manager;
            const activeIdx = wsm.get_active_workspace_index();
            parts.push(activeIdx, this._settings.get_boolean('show-workspace-current') ? 1 : 0);
            for (let i = 0; i < wsm.get_n_workspaces(); i++) {
                const ws = wsm.get_workspace_by_index(i);
                parts.push(`${i}:${ids(ws.list_windows().filter(w => _isNormal(w)))}`);
            }
        } else if (mode === 'apps') {
            const groups = _groupByApp(this._activeWs(), global.display.get_focus_window());
            for (const g of groups)
                parts.push(`${g.app ? g.app.get_id() : '?'}:${ids(g.windows)}`);
        } else if (mode === 'all-windows') {
            // Every window is its own card here, so each one's shape matters —
            // ids() only buckets the front window's aspect.
            const wsm = global.workspace_manager;
            const focused = global.display.get_focus_window();
            const winSig = w =>
                `${w.get_id()}@${Math.round((this._windowAspect(w) ?? 0) * 20)}`;
            parts.push(focused ? focused.get_id() : 0);
            for (let i = 0; i < wsm.get_n_workspaces(); i++) {
                const ws = wsm.get_workspace_by_index(i);
                if (!ws) continue;
                const wins = ws.list_windows().filter(w => _isNormal(w) && w !== focused);
                parts.push(`${i}:${wins.map(winSig).join('.')}`);
            }
        } else {
            for (const g of this._getInactiveGroups())
                parts.push(`${g.id}:${ids(this._groupWindows(g))}`);
        }
        return parts.join('|');
    }

    _refreshGroups() {
        const all = this._getInactiveGroups();
        for (const group of all.slice(0, MAX_GROUPS)) {
            const card = this._makeGroupCard(group);
            if (card) { this._box.add_child(card); this._cards.push(card); }
        }
        this._addOverflowLabel(all.length - MAX_GROUPS);
    }

    _refreshApps() {
        const focusedWin = global.display.get_focus_window();
        const all = _groupByApp(this._activeWs(), focusedWin);
        for (const group of all.slice(0, MAX_GROUPS)) {
            const card = this._makeAppCard(group);
            if (card) { this._box.add_child(card); this._cards.push(card); }
        }
        this._addOverflowLabel(all.length - MAX_GROUPS);
    }

    /** Every window on every workspace, one card each, under a workspace header.
     *  Deliberately READ-ONLY: it never minimizes, regroups or moves a window, so
     *  the workspace-scoped stage model is untouched. Clicking just activates the
     *  window and lets mutter switch workspace itself. */
    _refreshAllWindows() {
        const wsm = global.workspace_manager;
        const focused = global.display.get_focus_window();
        const n = wsm.get_n_workspaces();
        let shown = 0;
        let total = 0;

        for (let i = 0; i < n; i++) {
            const ws = wsm.get_workspace_by_index(i);
            if (!ws) continue;
            // The focused window is already in front of you — showing it would
            // just be a card of what you are looking at.
            const wins = ws.list_windows()
                .filter(w => _isNormal(w) && w !== focused)
                .sort((a, b) => (b.get_user_time() || 0) - (a.get_user_time() || 0));
            total += wins.length;
            if (wins.length === 0) continue;

            // Header only when at least one of this workspace's cards will fit,
            // or an empty heading is left dangling at the cap.
            if (shown >= MAX_GROUPS) continue;
            this._addWorkspaceHeader(i);

            for (const win of wins) {
                if (shown >= MAX_GROUPS) break;
                const card = this._makeWindowCard(win);
                if (card) { this._box.add_child(card); this._cards.push(card); shown++; }
            }
        }
        this._addOverflowLabel(total - shown);
    }

    /** Workspace heading in all-windows mode. Not pushed to `_cards` — it is a
     *  label, not a hover/bell-curve target (same rule as the overflow label). */
    _addWorkspaceHeader(wsIndex) {
        if (!this._box) return;
        this._box.add_child(new St.Label({
            text: _('Workspace %d').replace('%d', `${wsIndex + 1}`),
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: this._cls('stage-ws-header'),
        }));
    }

    /** A single-window card for all-windows mode. */
    _makeWindowCard(win) {
        const windows = [win];
        const card = this._wrapCard();
        const thumb = this._makeStackedThumb(windows);
        card.add_child(thumb);
        card._thumb = thumb;

        if (this._settings.get_boolean('show-app-icons')) {
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            if (app) {
                const iconBox = new St.BoxLayout({
                    x_align: Clutter.ActorAlign.CENTER,
                    style: 'margin-top: 5px;',
                });
                iconBox.add_child(app.create_icon_texture(ICON_SIZE));
                card.add_child(iconBox);
            }
        }

        card.set_pivot_point(0.5, 0.5);
        const idx = this._cards.length;
        this._wireCardEvents(card, thumb, windows, idx);
        this._cardSig(card, 'button-release-event', () => {
            this._destroyPreview();
            this._activateWindow(win);
            return Clutter.EVENT_STOP;
        });
        return card;
    }

    /** Bring one window to the front. mutter switches to its workspace itself,
     *  so no window is ever moved between workspaces here. */
    _activateWindow(win) {
        if (win.minimized) win.unminimize();
        win.activate(global.get_current_time());
        if (this._settings.get_boolean('sidebar-auto-hide')) this._scheduleHide();
        this._scheduleRefresh();
    }

    /** Show "+N" for stages beyond MAX_GROUPS instead of dropping them silently.
     *  Not pushed to `_cards` — it's a label, not a hover/bell-curve target. */
    _addOverflowLabel(hidden) {
        if (hidden <= 0 || !this._box) return;
        this._box.add_child(new St.Label({
            text: `+${hidden}`,
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: this._cls('stage-overflow'),
        }));
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
            const card = this._makeWorkspaceCard(ws, wins, i, i === activeIdx);
            if (card) { this._box.add_child(card); this._cards.push(card); }
        }
    }

    _safeDestroyContent() {
        if (!this._box) return;
        _nullCloneSources(this._box);
        this._box.destroy_all_children();
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

            // Perspective goes on the CARD, not the thumbnail — rotating only the
            // child let content spill outside the card's pill background.
            card.rotation_angle_y = angle;

            card.ease({
                opacity: CARD_REST_OPACITY,
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

    /** Card wrapper with a frosted-glass pill background (see stylesheet.css).
     *  The only reactive actor in the sidebar — the panel passes input through. */
    _wrapCard() {
        const card = new St.BoxLayout({
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: this._cls('stage-card'),
        });
        this._setVertical(card);
        return card;
    }

    /** Build a style_class string with the active theme variant appended. */
    _cls(...names) {
        if (this._themeClass)
            return [...names, this._themeClass].join(' ');
        return names.join(' ');
    }

    _makeGroupCard(group) {
        const windows = this._groupWindows(group);
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

        this._cardSig(card, 'button-release-event', () => {
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

        this._cardSig(card, 'button-release-event', () => {
            this._destroyPreview();
            this._activateApp(group);
            return Clutter.EVENT_STOP;
        });

        return card;
    }

    _activateApp(group) {
        const { windows } = group;
        if (windows.length === 0) return;
        for (const win of windows) { if (win.minimized) win.unminimize(); }
        windows[0].activate(global.get_current_time());
        if (this._settings.get_boolean('sidebar-auto-hide')) this._scheduleHide();
        this._scheduleRefresh();
    }

    /** Aspect-correct clone of win's whole compositor actor (shadow included,
     *  never cropped), scaled to fit maxW×maxH and capped at maxScale. */
    _makeWindowClone(win, maxW, maxH, maxScale = Infinity) {
        // Live clone preferred (works for minimized windows too, like alt-tab);
        // the cached still is only a fallback for a gone/unusable actor.
        const geom = this._windowGeometry(win) ?? this._snapshots.get(win);
        if (!geom) return null;

        const { aw, ah } = geom;
        const scale = Math.min(maxW / aw, maxH / ah, maxScale);

        const inner = geom.content
            ? new St.Widget({ reactive: false, content: geom.content })
            : new Clutter.Clone({ source: geom.actor, reactive: false });
        inner.set_size(Math.round(aw * scale), Math.round(ah * scale));
        return inner;
    }

    /** Size of `win`'s compositor actor — the whole thing, shadow included. */
    _windowGeometry(win) {
        const actor = win.get_compositor_private?.();
        if (!actor) return null;

        const [aw, ah] = actor.get_size();
        if (!(aw > 0) || !(ah > 0)) return null;

        return { aw, ah, actor, content: null };
    }

    /** Freeze win's current appearance as a last-resort thumbnail, for when its
     *  actor is gone by draw time. Must be called while still on screen (needs a
     *  live buffer); cache is capped, oldest evicted first. */
    _captureSnapshot(win) {
        const geom = this._windowGeometry(win);
        if (!geom) return;
        if (typeof geom.actor.paint_to_content !== 'function') return;

        // Returns null when the actor has no drawable buffer; the icon
        // fallback covers that case.
        const content = geom.actor.paint_to_content(null);
        if (!content) return;
        this._snapshots.delete(win);   // re-insert so it counts as newest
        this._snapshots.set(win, { aw: geom.aw, ah: geom.ah, actor: null, content });
        while (this._snapshots.size > MAX_SNAPSHOTS)
            this._snapshots.delete(this._snapshots.keys().next().value);
    }

    _dropSnapshot(win) {
        this._snapshots.delete(win);
    }

    /** Clamp an aspect ratio into the range a card can sensibly display. */
    _clampAspect(ratio) {
        if (!(ratio > 0)) return null;
        return Math.min(THUMB_ASPECT_MAX, Math.max(THUMB_ASPECT_MIN, ratio));
    }

    /** Shape of what will actually be drawn, so the window fills its card
     *  (frame rect is only a fallback for a window with no actor yet). */
    _windowAspect(win) {
        const geom = this._windowGeometry(win) ?? this._snapshots.get(win);
        if (geom) return this._clampAspect(geom.aw / geom.ah);
        const r = win.get_frame_rect();
        if (r && r.width > 0 && r.height > 0)
            return this._clampAspect(r.width / r.height);
        return null;
    }

    /** Shape of the display — what a maximized window looks like. */
    _monitorAspect() {
        const mon = Main.layoutManager.primaryMonitor;
        return (mon && this._clampAspect(mon.width / mon.height)) ??
               this._clampAspect(THUMB_W / THUMB_H);
    }

    /** Thumbnail size for a stack of `count` windows, derived from the sidebar
     *  width — a fixed THUMB_W doesn't fit once fan-out + card padding are added. */
    _thumbSize(count, aspect = null) {
        const sf = this._scaleFactor;
        const layers = Math.min(Math.max(count, 1), MAX_STACK);
        const perspective = 1 + (this._PERSP_ANGLE / 45) * PERSP_HEADROOM;
        const budget = (this._PANEL_W - CARD_MARGIN * sf) / perspective - 2 * CARD_PAD_X * sf;

        // Fan-out is a fraction of the thumbnail, not a fixed offset, so
        // `w + (layers-1)·w·k ≤ budget` always has a solution.
        const k = STACK_H / THUMB_W;
        const fitted = budget / (1 + (layers - 1) * k);

        // No upper cap: a wider sidebar is a request for bigger cards.
        const w = Math.round(Math.max(MIN_THUMB_W * sf, fitted));
        const ratio = aspect ?? this._monitorAspect();
        return [w, Math.round(w / ratio)];
    }

    /** Per-layer stack offsets, kept proportional to the thumbnail size. */
    _stackStep(thumbW) {
        return [thumbW * (STACK_H / THUMB_W), thumbW * (STACK_V / THUMB_W)];
    }

    _makeStackedThumb(windows) {
        const sf = this._scaleFactor;
        // The card takes its shape from the window it fronts, falling back to the
        // display's shape for an empty stage. Nothing here is a fixed aspect.
        const aspect = windows.length > 0 ? this._windowAspect(windows[0]) : null;
        const [tw, th] = this._thumbSize(windows.length, aspect);
        const [sh, sv] = this._stackStep(tw);
        const n = Math.min(windows.length, MAX_STACK);
        // An empty stage still renders one empty slot; `n - 1` would otherwise
        // give the container a negative fan-out and shrink it below the layer.
        const layers = Math.max(n, 1);
        const totalH = (layers - 1) * sh;
        const totalV = (layers - 1) * sv;
        const container = new St.Widget({ reactive: false });
        container.set_size(tw + totalH, th + totalV);

        // Render back → front: back cards fan out to the right
        for (let i = n - 1; i >= 0; i--) {
            const win = windows[i];
            const x = i * sh;
            const y = i * sv;
            const isFront = (i === 0);
            const layerOpacity = isFront ? 255 : Math.max(140, 210 - i * 30);

            const layer = new St.Widget({
                reactive: false,
                style_class: this._cls(isFront ? 'stage-thumb-layer' : 'stage-thumb-layer-back'),
                opacity: layerOpacity,
            });
            layer.set_size(tw, th);
            layer.set_position(x, y);

            const content = this._makeWindowClone(win, tw, th);
            if (content) {
                content.set_position(
                    Math.round((tw - content.width) / 2),
                    Math.round((th - content.height) / 2));
                layer.add_child(content);
            } else {
                this._addIconFallback(layer, win, tw, th);
            }

            container.add_child(layer);
        }

        const children = container.get_children();
        container._frontLayer = children.length > 0 ? children[children.length - 1] : null;

        // Count badge — bottom-left of front layer
        if (windows.length > 1 && this._settings.get_boolean('show-group-count')) {
            const badge = new St.Label({
                text: `${windows.length}`,
                style_class: this._cls('stage-badge'),
                reactive: false,
            });
            badge.set_position(4 * sf, th - 20 * sf);
            container.add_child(badge);
        }

        return container;
    }

    _addIconFallback(layer, win, tw, th) {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (app) {
            const sf = this._scaleFactor;
            const iconPx = 48 * sf;
            const icon = app.create_icon_texture(48);  // px arg is logical
            icon.set_position((tw - iconPx) / 2, (th - iconPx) / 2);
            layer.add_child(icon);
        }
    }

    _makeWorkspaceCard(ws, wins, wsIndex, isCurrent) {
        const card = this._wrapCard();
        const thumb = this._makeStackedThumb(wins);
        card.add_child(thumb);
        card._thumb = thumb;

        // %d is substituted rather than interpolated so translators keep control
        // of word order.
        const wsName = isCurrent
            ? _('Workspace %d (current)').replace('%d', `${wsIndex + 1}`)
            : _('Workspace %d').replace('%d', `${wsIndex + 1}`);
        card.add_child(new St.Label({
            text: wsName,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: this._cls(isCurrent ? 'stage-ws-label-current' : 'stage-ws-label'),
        }));
        if (wins.length > 0) {
            card.add_child(new St.Label({
                text: ngettext('%d window', '%d windows', wins.length)
                    .replace('%d', `${wins.length}`),
                x_align: Clutter.ActorAlign.CENTER,
                style_class: this._cls('stage-ws-meta'),
            }));
        }

        card.set_pivot_point(0.5, 0.5);
        const idx = this._cards.length;
        this._wireCardEvents(card, thumb, wins, idx);
        this._cardSig(card, 'button-release-event', () => {
            this._destroyPreview();
            if (!isCurrent) ws.activate(global.get_current_time());
            if (this._settings.get_boolean('sidebar-auto-hide')) this._scheduleHide();
            this._scheduleRefresh();
            return Clutter.EVENT_STOP;
        });
        return card;
    }

    // ── Bell curve scaling ──────────────────────────────────────────────

    /** Ease all cards back to resting state. Eases rather than snaps — snapping
     *  cancelled a card's own in-flight leave-event ease, causing a visible jump. */
    _resetAllCardScales() {
        const base = this._BASE_SCALE;
        const angle = this._PERSP_ANGLE;
        for (const card of this._cards) {
            card.ease({
                scale_x: base, scale_y: base,
                opacity: CARD_REST_OPACITY,
                rotation_angle_y: angle,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /** Bell curve: hovered card scales to 1.0 and goes flat; only 1-2 neighbors
     *  are affected (tight sigma). */
    _applyBellCurve(hoveredIdx) {
        const base = this._BASE_SCALE;
        const angle = this._PERSP_ANGLE;

        for (let i = 0; i < this._cards.length; i++) {
            const dist = Math.abs(i - hoveredIdx);
            const factor = _bellCurve(dist, BELL_SIGMA);
            const s = base + (1.0 - base) * factor;
            const op = Math.round(
                CARD_REST_OPACITY + (CARD_HOVER_OPACITY - CARD_REST_OPACITY) * factor);
            // Perspective: hovered card goes flat, distant ones keep full angle.
            const rot = angle * (1.0 - factor);

            this._cards[i].ease({
                scale_x: s, scale_y: s,
                opacity: op,
                rotation_angle_y: rot,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    // ── Card events ─────────────────────────────────────────────────────

    _wireCardEvents(card, thumb, windows, cardIdx) {
        // Cards are the only reactive actors in the sidebar, so the wheel has to
        // be handled here — not just on the (non-reactive) scroll view.
        this._cardSig(card, 'scroll-event', (_actor, event) => this._onScrollEvent(event));

        this._cardSig(card, 'enter-event', () => {
            this._hovered = true;
            this._killHideTimer();
            this._hoveredIdx = cardIdx;

            this._applyBellCurve(cardIdx);

            // Glow on front layer + highlight card pill — use style classes
            // so light/dark theme variants apply.
            const front = thumb._frontLayer;
            if (front)
                front.set_style_class_name(this._cls('stage-thumb-layer-front-hover'));
            card.set_style_class_name(this._cls('stage-card', 'stage-card-hover'));

            // Preview after short delay
            this._killHoverTimer();
            this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                this._hoverTimer = null;
                this._showPreview(card, windows);
                return GLib.SOURCE_REMOVE;
            });
        });

        this._cardSig(card, 'leave-event', (_actor, event) => {
            this._hoveredIdx = -1;
            this._resetAllCardScales();

            // Restore base style classes
            const front = thumb._frontLayer;
            if (front)
                front.set_style_class_name(this._cls('stage-thumb-layer'));
            card.set_style_class_name(this._cls('stage-card'));

            this._killHoverTimer();
            this._destroyPreview();

            // Auto-hide is driven from the cards too, since they're the only
            // reactive actors now — both this and the panel's handler running is harmless.
            if (!this._insidePanel(this._crossingRelated(event))) {
                this._hovered = false;
                if (this._settings.get_boolean('sidebar-auto-hide'))
                    this._scheduleHide();
            }
        });
    }

    // ── Preview ─────────────────────────────────────────────────────────

    /** Larger preview of ALL windows in the group, tiled vertically. Falls back
     *  to an icon grid when no compositor actors are available. */
    _showPreview(card, windows) {
        this._destroyPreview();

        const mon = Main.layoutManager.primaryMonitor;
        const topH = Main.panel ? Main.panel.height : 0;
        const [, cardY] = card.get_transformed_position();

        // Collect windows that have compositor actors (cloneable)
        const cloneable = windows.filter(w => !!w.get_compositor_private());

        if (cloneable.length === 0) {
            this._showIconPreview(windows, cardY);
            return;
        }

        // Tile vertically; capped in logical units so the preview is the same
        // physical size at any display density.
        const sf = this._scaleFactor;
        const maxPreviewW = Math.min(mon.width * 0.32, 500 * sf);
        const padding = 8 * sf;
        const gap = 6 * sf;
        const shown = Math.min(cloneable.length, 4);
        const maxWinH = (mon.height * 0.45 - padding * 2 - gap * (shown - 1)) / shown;
        const clones = [];
        let maxCloneW = 0;
        let totalH = padding * 2;

        for (const w of cloneable.slice(0, 4)) {
            // Shares the thumbnail clone helper; capped at 1:1 so a small window
            // is never magnified into blur.
            const holder = this._makeWindowClone(w, maxPreviewW - padding * 2, maxWinH, 1.0);
            if (!holder) continue;
            clones.push(holder);
            totalH += holder.height + gap;
            maxCloneW = Math.max(maxCloneW, holder.width);
        }

        if (clones.length === 0) {
            this._showIconPreview(windows, cardY);
            return;
        }

        totalH -= gap; // remove trailing gap
        const previewW = maxCloneW + padding * 2;
        const previewH = totalH;

        const py = Math.max(mon.y + topH + 8 * sf,
            Math.min(cardY, mon.y + mon.height - previewH - 20 * sf));

        this._preview = new St.Widget({
            style_class: this._cls('stage-preview'),
            reactive: false,
        });
        this._preview.set_size(previewW, previewH);
        this._preview.set_position(mon.x + this._PANEL_W + 8 * sf, py);

        let yOff = padding;
        for (const holder of clones) {
            holder.set_position(padding + (maxCloneW - holder.width) / 2, yOff);
            this._preview.add_child(holder);
            yOff += holder.height + gap;
        }

        Main.layoutManager.addChrome(this._preview, { trackFullscreen: false });
        this._preview.set_opacity(0);
        this._preview.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    /** Fallback preview: app icons + names when clones aren't available. */
    _showIconPreview(windows, cardY) {
        const tracker = Shell.WindowTracker.get_default();
        const mon = Main.layoutManager.primaryMonitor;
        const topH = Main.panel ? Main.panel.height : 0;
        const sf = this._scaleFactor;

        const previewW = 220 * sf;
        const previewH = 160 * sf;

        this._preview = new St.Widget({
            style_class: this._cls('stage-preview'),
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

        let yOff = 14 * sf;
        const names = [...seenApps.values()].map(a => a.get_name()).join(', ');
        const title = new St.Label({
            text: names || _('Application'),
            style_class: this._cls('stage-preview-title'),
        });
        title.set_position(14 * sf, yOff);
        title.set_width(previewW - 28 * sf);
        this._preview.add_child(title);
        yOff += 28 * sf;

        let xOff = 14 * sf;
        const iconStep = 56 * sf;
        const iconPx = 48 * sf;
        for (const [, app] of seenApps) {
            const icon = app.create_icon_texture(48);
            icon.set_position(xOff, yOff);
            this._preview.add_child(icon);
            xOff += iconStep;
            if (xOff + iconPx > previewW) { xOff = 14 * sf; yOff += iconStep; }
        }

        this._preview.add_child(new St.Label({
            text: ngettext('%d window (minimized)', '%d windows (minimized)', windows.length)
                .replace('%d', `${windows.length}`),
            style_class: this._cls('stage-preview-meta'),
            x: 14 * sf, y: previewH - 24 * sf,
        }));

        Main.layoutManager.addChrome(this._preview, { trackFullscreen: false });
        this._preview.set_opacity(0);
        this._preview.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    _destroyPreview() {
        if (this._preview) {
            _nullCloneSources(this._preview);
            Main.layoutManager.removeChrome(this._preview);
            this._preview.destroy();
            this._preview = null;
        }
    }

    // ── Util ──
    // Per-timer kill helpers — named explicitly so shexli (EGO-L-004) can trace
    // GLib.source_remove(this._fooTimer) statically.

    _killRefreshTimer() {
        if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._refreshTimer = null; }
    }

    _killHideTimer() {
        if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._hideTimer = null; }
    }

    _killHoverTimer() {
        if (this._hoverTimer) { GLib.source_remove(this._hoverTimer); this._hoverTimer = null; }
    }

    _killSwapTimer() {
        if (this._swapTimer) { GLib.source_remove(this._swapTimer); this._swapTimer = null; }
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
        // Null-guarded: if enable() threw part-way through, one of these is
        // still unset and an unguarded call would throw again out of disable().
        if (this._side) this._side.disable();
        if (this._max) this._max.disable();
        this._side = null;
        this._max = null;
        this._settings = null;
    }
}
