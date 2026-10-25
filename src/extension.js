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
// Must match .stage-card's padding in stylesheet.css (8px 14px), or cards overflow.
const CARD_PAD_X = 14;
const CARD_PAD_Y = 8;
const CARD_MARGIN = 8;    // breathing room between the card and the panel edges
const SCROLL_STEP = 55;   // wheel travel per notch
const PERSP_HEADROOM = 0.18;   // extra width to budget for a rotated card's projection
// Clamp window shape so an extreme window (sliver, ultrawide) can't produce an absurd card.
const THUMB_ASPECT_MIN = 0.7;
const THUMB_ASPECT_MAX = 2.4;
const CARD_REST_OPACITY = 190;    // resting card opacity
const CARD_HOVER_OPACITY = 255;   // fully opaque at the centre of the bell curve
const KEYBIND_NAME = 'toggle-sidebar';
const SHOW_DESKTOP_KEYBIND = 'keybinding-show-desktop';
const COVER_CHECK_MS = 120;   // a maximize or a drag ends in a burst of signals; check once
const APP_DRAG_THRESHOLD = 18;    // logical px — past this, a press+release is a drag, not a click
const APP_GHOST_SIZE = 96;        // logical px; the card thumbnail that follows the pointer
// Last-resort geometry when the compositor reports no monitor at all (see _getMon).
const MON_FALLBACK = { x: 0, y: 0, width: 1920, height: 1080, index: 0 };


// ─── Helpers ────────────────────────────────────────────────────────────────

/** Primary monitor, from Meta.Display — Main.layoutManager.primaryMonitor is
 *  empty under gnome-remote-desktop (issue #8). Always carries `index`, which
 *  _fullscreen() needs. Never returns null. */
function _getMon() {
    const display = global.display;
    const primary = display.get_primary_monitor();
    const index = primary >= 0 ? primary : 0;   // -1 before the config is read

    if (display.get_n_monitors() > index) {
        const rect = display.get_monitor_geometry(index);
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, index };
    }
    return Main.layoutManager.primaryMonitor ?? MON_FALLBACK;
}


function _isNormal(win) {
    if (!win) return false;
    if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
    if (win.skip_taskbar || win.is_attached_dialog()) return false;
    // Also user-stuck windows (window menu, or another monitor when workspaces are
    // primary-only): on every workspace at once, so no one stage can hold them.
    if (win.is_on_all_workspaces()) return false;
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

/** Group windows by app ('apps' mode). Merged apps (drag-to-merge) fold into
 *  one group; every group carries `key` and `apps` so callers never branch. */
function _groupByApp(workspace, focusedWindow, mergeMap = new Map()) {
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

    const byGroup = new Map(); // resolved key -> { apps: [], windows: [] }
    for (const [appId, entry] of appMap) {
        const key = mergeMap.get(appId) ?? appId;
        if (!byGroup.has(key)) byGroup.set(key, { apps: [], windows: [] });
        const bucket = byGroup.get(key);
        bucket.apps.push(entry.app);
        bucket.windows.push(...entry.windows);
    }

    return [...byGroup.entries()].map(([key, g]) =>
        ({ key, app: g.apps[0], apps: g.apps, windows: g.windows }));
}


// ─── MaximizeToWorkspace ────────────────────────────────────────────────────

class MaximizeToWorkspace {
    /** `saved`: what exportState() returned before the lock screen, or null. */
    constructor(settings, saved = null) {
        this._settings = settings;
        this._saved = saved;
        this._sigSources = new Set();
        this._timers = [];
        this._moved = new Set();
        this._moving = new Set();   // windows our own move is changing workspace right now
        // win → origin Meta.Workspace, never an index — mutter reaps empty
        // workspaces, so a stored index can end up pointing at the wrong one.
        this._origin = new Map();
    }

    enable() {
        this._sig(global.window_manager, 'size-change', this._onSize.bind(this));
        this._restore(this._saved);
        this._saved = null;
    }

    disable() {
        this._sigSources.forEach(o => o.disconnectObject(this));
        this._sigSources.clear();
        this._timers.splice(0).forEach(id => GLib.source_remove(id));
        this._moved.clear();
        this._moving.clear();
        this._origin.clear();
    }

    /** Plain data for the lock screen, which disables extensions: stable sequence →
     *  origin index. Indices hold only while the workspace count is unchanged. */
    exportState() {
        const wsm = global.workspace_manager;
        return {
            n: wsm.get_n_workspaces(),
            origins: [...this._origin].map(([win, ws]) => [win.get_stable_sequence(), ws.index()]),
        };
    }

    _restore(saved) {
        const wsm = global.workspace_manager;
        if (!saved || saved.n !== wsm.get_n_workspaces()) return;
        const bySeq = new Map(global.display.list_all_windows().map(w => [w.get_stable_sequence(), w]));
        for (const [seq, i] of saved.origins) {
            const win = bySeq.get(seq);
            const ws = wsm.get_workspace_by_index(i);
            if (win && ws) this._track(win, ws);
        }
    }

    /** Remember where `win` came from. 'unmanaged' fires for every close, unlike the
     *  wm 'destroy' effect, which mutter skips for a window that isn't on screen. */
    _track(win, ws) {
        this._moved.add(win);
        this._origin.set(win, ws);
        win.connectObject('unmanaged', () => this._forget(win), this);
        this._sigSources.add(win);
    }

    _forget(win) {
        this._moved.delete(win);
        this._origin.delete(win);
        win.disconnectObject(this);
        this._sigSources.delete(win);
    }

    /** Move `win` to `ws` and follow it. Size changes during the move are ignored:
     *  Ubuntu's tiling-assistant re-tiles a moved window by unmaximizing and
     *  maximizing it again, which bounced it between workspaces. */
    _move(win, ws) {
        this._moving.add(win);
        if (ws.active) {
            win.change_workspace(ws);
            win.activate(global.get_current_time());
        } else {
            Main.wm.actionMoveWindow(win, ws);
        }
        this._moving.delete(win);
    }

    _sig(o, s, cb) {
        o.connectObject(s, cb, this);
        this._sigSources.add(o);
    }

    /** Drop an id from this._timers once its source is gone. Every timeout is
     *  pushed to that array at creation so disable() can loop over the rest. */
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
        if (!win || !_isNormal(win) || this._moving.has(win)) return;

        if (change === Meta.SizeChange.MAXIMIZE) {
            // Only the outbound move is opt-in — a window already parked must
            // still be able to return even if the setting was since changed.
            if (this._settings.get_string('maximize-behavior') !== 'workspace') return;
            // Only a FULL maximize (both axes) moves the window; edge tiling
            // (snapping to a half) is a single-axis maximize and must stay put.
            // is_maximized() is a gboolean, not MetaMaximizeFlags, so the per-axis
            // properties are the only way to tell the two apart.
            if (!win.maximized_horizontally || !win.maximized_vertically) return;
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

        this._track(win, cws);
        const target = wsm.get_workspace_by_index(ti);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._untrackTimer(id);
            // The shell's own move: the window rides the switch animation rather than
            // being moved under it. Skipped if unmaximized meanwhile or the target was reaped.
            if (this._origin.get(win) === cws && this._workspaceAlive(target))
                this._move(win, target);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(id);
    }

    _handleUnmaximize(win) {
        const originWs = this._origin.get(win);
        if (!originWs) return;

        this._forget(win);

        // The origin may be gone entirely (user closed all its windows and
        // mutter reaped it), in which case leave the window where it is.
        if (!this._workspaceAlive(originWs)) return;
        if (win.get_workspace() === originWs) return;

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._untrackTimer(id);
            const ws = win.get_workspace();   // null once the window is closed
            if (ws && ws !== originWs && this._workspaceAlive(originWs))
                this._move(win, originWs);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(id);
    }
}


// ─── StageSidebar ───────────────────────────────────────────────────────────

class StageSidebar {
    /** `saved`: what exportState() returned before the lock screen, or null. */
    constructor(settings, saved = null) {
        this._settings = settings;
        this._saved = saved?.stack ?? null;
        this._sigSources = new Set();      // persistent signal sources (cleared in disable)
        this._cardSigSources = new Set();  // per-card signal sources (cleared each refresh)
        this._cards = [];
        this._panel = null;
        this._edge = null;
        this._box = null;
        this._scroll = null;
        this._preview = null;
        this._timers = [];               // every live timeout id (drained in disable)
        this._hoverTimer = null;
        this._refreshTimer = null;
        this._hideTimer = null;
        this._swapTimer = null;
        this._edgeTimer = null;          // pointer-dwell before an edge reveal
        this._coverTimer = null;         // debounced hide-when-covered check
        this._deskTimer = null;          // waits for a desktop-icon press to end as a click
        this._wallpaperOwner = {};       // owns the stage's wallpaper-click handler
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
        this._parkSeq = 0;          // stamps g.parkedAt, so the card cap keeps the newest

        // Windows whose next minimize/unminimize was caused by us during a swap
        // (consumed by the handlers, so it's never mistaken for the user's own action).
        this._expectMinimize = new Set();
        this._expectUnminimize = new Set();

        this._signature = null;     // fingerprint of what is currently rendered

        // Chrome registration state — the panel is re-registered when its
        // struts setting changes (see _applyChrome).
        this._chromeAdded = false;
        this._chromeStruts = false;

        this._appMergeMap = new Map();   // appId -> resolved merge-group key, see _groupByApp
        this._appDrag = null;            // in-flight drag-to-merge candidate, see _startAppDragCandidate
        this._appDragGhost = null;       // thumbnail following the pointer during that drag

        // win → group id it was promoted out of by maximize-behavior='stage',
        // so unmaximize can put it back instead of stranding it in a lone stage.
        this._maxOrigin = new Map();
    }

    // ── Signal & timer tracking ─────────────────────────────────────────
    // Every signal must flow through _sig()/_cardSig() (connectObject, tracked
    // per-source) so disable() can disconnectObject(this) on each (EGO-L-003).

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
    /** Pointer dwell before an edge reveal. A duration, so it is NOT scaled. */
    get _EDGE_DELAY_MS() { return this._settings.get_int('edge-trigger-delay'); }
    get _BASE_SCALE() { return this._settings.get_int('card-base-scale') / 100.0; }
    get _PERSP_ANGLE() { return this._settings.get_int('perspective-angle'); }
    get _POS() { return this._settings.get_string('stack-panel-position'); }
    /** Left/right stack the cards in a column; bottom lays them in a row.
     *  Everything position-dependent branches on this, not on _POS. */
    get _VERTICAL() { return this._POS !== 'bottom'; }
    /** Perspective tilt direction — mirrored on the right so cards still
     *  face into the screen instead of away from it. */
    get _ROT_SIGN() { return this._POS === 'right' ? -1 : 1; }
    /** Honour the desktop "Reduce Animation" toggle — every duration collapses
     *  to 0 so eases become instant snaps (also the fastest feel available). */
    get _REDUCED_MOTION() { return St.Settings.get().enable_animations === false; }
    /** Ease duration with reduce-motion applied; 0 = snap. */
    _animMs(ms) { return this._REDUCED_MOTION ? 0 : ms; }

    // ── Position-aware geometry (left = default; right mirrors, bottom rotates).
    // sidebar-width is the panel's THICKNESS on whichever edge it occupies. ──
    _panelSize(mon, topH) {
        return this._VERTICAL
            ? [this._PANEL_W, mon.height - topH]
            : [mon.width, this._PANEL_W];
    }
    _panelVisiblePos(mon, topH) {
        if (!this._VERTICAL) return [mon.x, mon.y + mon.height - this._PANEL_W];
        return [this._POS === 'right' ? mon.x + mon.width - this._PANEL_W : mon.x, mon.y + topH];
    }
    _panelHiddenPos(mon, topH) {
        if (!this._VERTICAL) return [mon.x, mon.y + mon.height];
        return [this._POS === 'right' ? mon.x + mon.width : mon.x - this._PANEL_W, mon.y + topH];
    }
    /** [x, y, w, h] of the edge trigger strip. */
    _edgeGeom(mon, topH) {
        const t = this._EDGE_W;
        return this._VERTICAL
            ? [this._POS === 'right' ? mon.x + mon.width - t : mon.x, mon.y + topH, t, mon.height - topH]
            : [mon.x, mon.y + mon.height - t, mon.width, t];
    }
    /** Preview floats on the panel's inward-facing side, tracking the card. */
    _previewPos(mon, topH, previewW, previewH, gap, cardX, cardY) {
        if (!this._VERTICAL) {
            const x = Math.max(mon.x + gap,
                Math.min(cardX, mon.x + mon.width - previewW - gap));
            return [x, mon.y + mon.height - this._PANEL_W - previewH - gap];
        }
        const x = this._POS === 'right'
            ? mon.x + mon.width - this._PANEL_W - previewW - gap
            : mon.x + this._PANEL_W + gap;
        return [x, Math.max(mon.y + topH + gap,
            Math.min(cardY, mon.y + mon.height - previewH - 20 * this._scaleFactor))];
    }

    enable() {
        this._recomputeScale();
        this._recomputeThemeClass();
        this._loadAppMergeMap();
        this._build();
        this._wire();
        if (this._saved) this._restoreGroups(this._saved);
        this._saved = null;
        this._initGroups();
        this._addKeybinding();
        if (!this._effectiveAutoHide())
            this._show();
        else if (this._shouldForceShow())
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
        this._killEdgeTimer();
        this._killCoverTimer();
        this._killDeskTimer();
        // Anything the named fields above did not cover.
        this._timers.splice(0).forEach(id => GLib.source_remove(id));
        // Keybinding before signals so the wm doesn't keep a stale handler.
        this._removeKeybinding();
        // Signals next (EGO-L-003).
        this._sigSources.forEach(o => o.disconnectObject(this));
        this._sigSources.clear();
        global.stage.disconnectObject(this._wallpaperOwner);
        this._disconnectCardSigs();
        this._cancelAppDrag();
        this._killAppDragGhost();
        // Then preview + card content (cards live inside _box).
        this._destroyPreview();
        this._safeDestroyContent();
        this._cards = [];
        this._groups = [];
        this._activeIds.clear();
        this._expectMinimize.clear();
        this._expectUnminimize.clear();
        this._appMergeMap.clear();
        this._maxOrigin.clear();
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
        const mon = _getMon();
        const topH = Main.panel ? Main.panel.height : 0;
        const vertical = this._VERTICAL;
        const [panelW, panelH] = this._panelSize(mon, topH);
        const [edgeX, edgeY, edgeW, edgeH] = this._edgeGeom(mon, topH);

        // Edge trigger — reactive by necessity, kept hidden except when needed
        // (_syncEdge), or it eats clicks/resize-grabs along the screen edge.
        this._edge = new St.Widget({
            reactive: true,
            style: 'background-color: transparent;',
        });
        this._edge.set_size(edgeW, edgeH);
        this._edge.set_position(edgeX, edgeY);
        Main.layoutManager.addChrome(this._edge, { trackFullscreen: false });
        this._sig(this._edge, 'enter-event', () => {
            if (this._fullscreen()) return;
            const delay = this._EDGE_DELAY_MS;
            if (delay <= 0) {
                this._revealFromEdge();
                return;
            }
            this._killEdgeTimer();
            this._edgeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._untrackTimer(this._edgeTimer); this._edgeTimer = null;
                // Re-checked: the dwell is long enough for a window to have
                // gone fullscreen since the pointer arrived.
                if (!this._fullscreen()) this._revealFromEdge();
                return GLib.SOURCE_REMOVE;
            });
            this._timers.push(this._edgeTimer);
        });
        // Pointer left before the dwell elapsed — it was a brush-past, not an
        // intent to open (issue #2: apps with their own left-edge hover UI).
        this._sig(this._edge, 'leave-event', () => this._killEdgeTimer());

        // reactive MUST stay false (here and on the scroll view) — a reactive
        // full-height panel would swallow every click/scroll in its column.
        this._panel = new St.Widget({
            reactive: false,
            style: 'background-color: transparent;',
        });
        this._panel.set_size(panelW, panelH);
        this._panel.set_position(...this._panelHiddenPos(mon, topH));
        // Hidden, not just off screen: the parked spot can be on a monitor to its left.
        this._panel.hide();
        this._visible = false;
        this._applyChrome();

        // ScrollView → BoxLayout. EXTERNAL, not NEVER, on the scrolling axis —
        // NEVER gives the adjustment no range, so scrolling could never move it.
        // EXTERNAL keeps the range and just hides the bar. The axis follows the
        // edge: a bottom strip scrolls horizontally, a side column vertically.
        this._scroll = new St.ScrollView({
            reactive: false,
            overlay_scrollbars: true,
            hscrollbar_policy: vertical ? St.PolicyType.NEVER : St.PolicyType.EXTERNAL,
            vscrollbar_policy: vertical ? St.PolicyType.EXTERNAL : St.PolicyType.NEVER,
            clip_to_allocation: true,
        });
        this._scroll.set_size(panelW, panelH);
        this._panel.add_child(this._scroll);

        const sf = this._scaleFactor;
        // Unlike the panel and scroll view, the card column IS reactive — the
        // smallest region that fixes scrolling without swallowing clicks elsewhere.
        this._box = new St.BoxLayout({
            reactive: true,
            x_align: vertical ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            y_align: vertical ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            style: vertical
                ? `padding: ${Math.round(24 * sf)}px 0px; spacing: ${Math.round(10 * sf)}px;`
                : `padding: 0px ${Math.round(24 * sf)}px; spacing: ${Math.round(10 * sf)}px;`,
        });
        this._setOrientation(this._box, vertical);
        this._scroll.set_child(this._box);

        // Bound on the column, on each card (_wireCardEvents) and on the scroll
        // view — never rely on one alone, since the scroll view isn't reactive.
        this._sig(this._box, 'scroll-event', (_actor, event) => this._onScrollEvent(event));
        this._sig(this._scroll, 'scroll-event', (_actor, event) => this._onScrollEvent(event));
        this._sig(this._box, 'button-release-event', () => { this._endAppDragCandidate(); return Clutter.EVENT_PROPAGATE; });

        // On the column, not the panel: Clutter only delivers crossing events to
        // reactive actors, so the panel's handlers never ran and leaving through
        // the gaps between cards left the sidebar stuck open.
        this._sig(this._box, 'enter-event', () => {
            this._hovered = true;
            this._killHideTimer();
            return Clutter.EVENT_PROPAGATE;
        });
        this._sig(this._box, 'leave-event', (_actor, event) => {
            // Ignore a leave when the pointer is only moving to another actor
            // inside the panel, or the preview/card scales tear down mid-gesture.
            if (this._insidePanel(this._crossingRelated(event)))
                return Clutter.EVENT_PROPAGATE;

            this._hovered = false;
            this._hoveredIdx = -1;
            this._killHoverTimer();
            this._resetAllCardScales();
            this._destroyPreview();
            if (this._effectiveAutoHide() && !this._shouldForceShow())
                this._scheduleHide();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /** Whether the sidebar should claim a strut right now. Struts are
     *  geometry-based and can't animate, so only true while genuinely parked on screen. */
    _wantStruts() {
        return this._settings.get_boolean('sidebar-reserve-space') &&
               !this._settings.get_boolean('sidebar-auto-hide') &&
               this._visible && !this._fullscreen();
    }

    /** Auto-hide as it applies now: the user's setting, or a window sitting under the
     *  always-visible sidebar (as macOS does). Never with reserved space: dropping the
     *  strut would let maximized windows grow back under the sidebar for good. */
    _effectiveAutoHide() {
        if (this._settings.get_boolean('sidebar-auto-hide')) return true;
        return this._settings.get_boolean('sidebar-hide-when-covered') &&
               !this._settings.get_boolean('sidebar-reserve-space') &&
               this._windowCoversPanel();
    }

    /** Whether a visible window on the active workspace overlaps where the
     *  sidebar sits when shown. Frame rects, so CSD shadows don't count. */
    _windowCoversPanel() {
        const ws = this._activeWs();
        if (!ws) return false;
        const mon = _getMon();
        const topH = Main.panel ? Main.panel.height : 0;
        const [px, py] = this._panelVisiblePos(mon, topH);
        const [pw, ph] = this._panelSize(mon, topH);
        return ws.list_windows().some(w => {
            if (!_isNormal(w) || w.minimized) return false;
            const r = w.get_frame_rect();
            return r.x < px + pw && r.x + r.width > px && r.y < py + ph && r.y + r.height > py;
        });
    }

    /** hide-when-covered: step aside while a window sits under the sidebar and
     *  come back once the area clears. Auto-hide users already get hover. */
    _syncCovered() {
        if (!this._panel || this._fullscreen()) return;
        if (this._settings.get_boolean('sidebar-auto-hide')) return;
        if (this._effectiveAutoHide()) {
            if (this._visible) this._scheduleHide();
        } else {
            this._killHideTimer();
            if (!this._visible) this._show();
        }
    }

    _scheduleCoverCheck() {
        this._killCoverTimer();
        this._coverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COVER_CHECK_MS, () => {
            this._untrackTimer(this._coverTimer); this._coverTimer = null;
            this._syncCovered();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._coverTimer);
    }

    /** Edge-hover reveal. Unlike an explicit toggle it must recede on its own
     *  if the pointer then leaves without touching a card: the panel is
     *  click-through, so no leave-event would ever arrive to hide it. */
    _revealFromEdge() {
        this._show();
        if (this._effectiveAutoHide()) this._scheduleHide();
    }

    /** Ubuntu's desktop icons (DING) are a DESKTOP window that takes focus on click, so
     *  the shell never sees the press; the focus change is the signal, but only while a
     *  primary press is dispatched (the button mask is not set yet; measured). */
    _parkIfDesktopFocused() {
        const focus = global.display.get_focus_window();
        if (focus?.get_window_type() !== Meta.WindowType.DESKTOP) return;
        // mutter raises a window on every click, so 'raised' still sees a click
        // while the desktop already has focus (e.g. right after an icon drag).
        if (!this._sigSources.has(focus)) {
            this._sig(focus, 'raised', () => this._parkIfDesktopFocused());
            this._sig(focus, 'unmanaged', () => { focus.disconnectObject(this); this._sigSources.delete(focus); });
        }
        const ev = Clutter.get_current_event();
        if (ev?.type() !== Clutter.EventType.BUTTON_PRESS || ev.get_button() !== Clutter.BUTTON_PRIMARY)
            return;
        // Park on the release, not the press: a press on an icon may start dragging
        // a file onto a window, which parking would minimize under the pointer.
        const [x0, y0] = global.get_pointer();
        this._killDeskTimer();
        this._deskTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            const [x, y, mask] = global.get_pointer();
            const dragged = Math.hypot(x - x0, y - y0) > APP_DRAG_THRESHOLD * this._scaleFactor;
            if (!dragged && (mask & Clutter.ModifierType.BUTTON1_MASK)) return GLib.SOURCE_CONTINUE;
            this._untrackTimer(this._deskTimer); this._deskTimer = null;
            const desk = global.display.get_focus_window()?.get_window_type() === Meta.WindowType.DESKTOP;
            if (!dragged && desk) this._parkOnDesktopClick();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._deskTimer);
    }

    /** macOS "click the wallpaper": park the current stage as one card. Groups
     *  mode only, and only in normal mode, so closing a menu or clicking in
     *  the overview never parks anything. */
    _parkOnDesktopClick() {
        if (Main.actionMode !== Shell.ActionMode.NORMAL) return;
        if (!this._settings.get_boolean('park-on-desktop-click')) return;
        if (this._settings.get_string('sidebar-mode') !== 'groups') return;
        this._showDesktop();
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
        // The scrolling axis follows the edge — a bottom strip scrolls its
        // hadjustment, a side column its vadjustment.
        const adj = this._VERTICAL ? this._scroll?.vadjustment : this._scroll?.hadjustment;
        if (!adj) return Clutter.EVENT_PROPAGATE;

        // Legacy mice only report a direction; get_scroll_delta() only means
        // something for SMOOTH, so branch on direction first, not probe it.
        let delta = 0;
        const vertical = this._VERTICAL;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            // A plain wheel reports only dy, so a bottom strip takes either axis.
            delta = vertical ? dy : (dx || dy);
        } else if (dir === Clutter.ScrollDirection.UP) {
            delta = -1;
        } else if (dir === Clutter.ScrollDirection.DOWN) {
            delta = 1;
        } else if (!vertical && dir === Clutter.ScrollDirection.LEFT) {
            delta = -1;
        } else if (!vertical && dir === Clutter.ScrollDirection.RIGHT) {
            delta = 1;
        }
        // A smooth-scroll gesture ends with a zero-delta event; let it through
        // instead of swallowing it.
        if (delta === 0) return Clutter.EVENT_PROPAGATE;

        const step = SCROLL_STEP * this._scaleFactor;
        const max = Math.max(0, adj.upper - adj.page_size);
        adj.value = Math.max(0, Math.min(max, adj.value + delta * step));
        return Clutter.EVENT_STOP;
    }

    /** Merge gesture: press starts a candidate, stage motion flags it as a
     *  drag past threshold, release on a different app card commits it. */
    _startAppDragCandidate(group, card) {
        this._cancelAppDrag();
        const [px, py] = global.get_pointer();
        this._appDrag = { group, card, startX: px, startY: py, moved: false };
        this._sig(global.stage, 'motion-event', (_a, event) => this._onAppDragMotion(event));
    }

    _onAppDragMotion(event) {
        if (!this._appDrag) return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        const dx = px - this._appDrag.startX;
        const dy = py - this._appDrag.startY;
        if (!this._appDrag.moved &&
            Math.hypot(dx, dy) > APP_DRAG_THRESHOLD * this._scaleFactor) {
            this._appDrag.moved = true;
            this._startAppDragGhost(this._appDrag.group);
        }
        if (this._appDrag.moved) this._updateAppDragGhost(px, py);
        return Clutter.EVENT_PROPAGATE;
    }

    /** Thumbnail that follows the pointer while merging. Without it the gesture
     *  gave no feedback at all, so a merge looked like nothing was happening. */
    _startAppDragGhost(group) {
        this._killAppDragGhost();
        const size = Math.round(APP_GHOST_SIZE * this._scaleFactor);
        const ghost = new St.Widget({
            reactive: false, width: size, height: size, opacity: 230,
            style_class: this._cls('stage-drag-ghost'),
        });
        ghost.set_pivot_point(0.5, 0.5);

        // Reuse the card thumbnail builder so the ghost looks like what is
        // being dragged; the icon fallback is already handled in there.
        const windows = group.windows ?? [];
        const thumb = this._makeWindowClone(windows[0], size, size);
        if (thumb) {
            thumb.set_position(
                Math.round((size - thumb.width) / 2),
                Math.round((size - thumb.height) / 2));
            ghost.add_child(thumb);
        } else if (windows[0]) {
            this._addIconFallback(ghost, windows[0], size, size);
        }

        Main.uiGroup.add_child(ghost);
        this._appDragGhost = ghost;
    }

    _updateAppDragGhost(px, py) {
        if (!this._appDragGhost) return;
        const half = Math.round(APP_GHOST_SIZE * this._scaleFactor / 2);
        this._appDragGhost.set_position(px - half, py - half);
    }

    _killAppDragGhost() {
        if (this._appDragGhost) {
            _nullCloneSources(this._appDragGhost);
            this._appDragGhost.destroy();
            this._appDragGhost = null;
        }
    }

    /** Resolve a pending drag on release; true = consumed, caller skips its
     *  click-activate. Target is hit-tested live — Clutter's implicit grab means release always fires on the origin card, not the pointer's target. */
    _endAppDragCandidate() {
        const drag = this._appDrag;
        if (!drag) return false;
        this._cancelAppDrag();
        if (!drag.moved) return false;
        const releaseGroup = this._appCardGroupAtPointer();
        if (releaseGroup && releaseGroup !== drag.group) this._onDragCommit(drag.group, releaseGroup);
        return true;
    }

    /** Group under the pointer, or null over blank space. Walks up from the
     *  hit actor since the pick can land on a card's child, not the card itself. */
    _appCardGroupAtPointer() {
        const [px, py] = global.get_pointer();
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, px, py);
        while (actor) {
            if (actor._group) return actor._group;
            actor = actor.get_parent();
        }
        return null;
    }

    _cancelAppDrag() {
        this._killAppDragGhost();
        this._appDrag = null;
        global.stage.disconnectObject(this);
    }

    _onDragCommit(sourceGroup, targetGroup) {
        for (const app of sourceGroup.apps) this._applyMerge(app.get_id(), targetGroup.key);
        this._saveAppMergeMap();
        this._scheduleRefresh();
    }

    /** The actor a crossing event is travelling to/from, if the event exposes one. */
    _crossingRelated(event) {
        return event?.get_related() ?? null;
    }

    _insidePanel(actor) {
        if (!actor || !this._panel) return false;
        return actor === this._panel || this._panel.contains(actor);
    }

    /** Whether the pointer is on the cards (or the edge strip that reveals them),
     *  measured at the panel's SETTLED position so a mid-slide check isn't fooled.
     *  Not the whole column: below the cards the pointer is over a window. */
    _pointerOverPanel() {
        if (!this._panel || !this._box) return false;
        const mon = _getMon();
        const topH = Main.panel ? Main.panel.height : 0;
        const [px, py] = global.get_pointer();
        const inRect = (x, y, w, h) => px >= x && px < x + w && py >= y && py < y + h;
        if (inRect(...this._edgeGeom(mon, topH))) return true;

        const [vx, vy] = this._panelVisiblePos(mon, topH);
        const [pw, ph] = this._panelSize(mon, topH);
        const [cx, cy] = this._panel.get_transformed_position();
        const box = this._box.get_transformed_extents();
        const x = vx + box.origin.x - cx;
        const y = vy + box.origin.y - cy;
        // Clipped to the panel: a scrolled column extends past it.
        const x0 = Math.max(x, vx), y0 = Math.max(y, vy);
        return inRect(x0, y0, Math.min(x + box.size.width, vx + pw) - x0,
            Math.min(y + box.size.height, vy + ph) - y0);
    }

    /** ease() property for the perspective tilt — Y axis for a column, X for a
     *  bottom strip, so the tilt always leans into the screen. */
    _rotProp(angle) {
        return this._VERTICAL ? { rotation_angle_y: angle } : { rotation_angle_x: angle };
    }

    /** `vertical` is deprecated in favor of `orientation` on GNOME 48+ — set
     *  whichever the running shell offers. */
    _setOrientation(box, vertical) {
        if ('orientation' in St.BoxLayout.prototype)
            box.orientation = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        else
            box.vertical = vertical;
    }

    /** Show the edge trigger only while actually needed (off screen, not
     *  fullscreen) — otherwise it steals input along the screen edge. */
    _syncEdge() {
        if (!this._edge) return;
        const wanted = !this._visible && !this._fullscreen();
        if (wanted) this._edge.show();
        else this._edge.hide();
    }

    // ── Layout rebuild (monitor / scale / size setting change) ───────────

    _rebuildLayout() {
        if (!this._panel || !this._edge || !this._scroll) return;
        const mon = _getMon();
        const topH = Main.panel ? Main.panel.height : 0;
        const vertical = this._VERTICAL;
        const [panelW, panelH] = this._panelSize(mon, topH);
        const [edgeX, edgeY, edgeW, edgeH] = this._edgeGeom(mon, topH);

        this._edge.set_size(edgeW, edgeH);
        this._edge.set_position(edgeX, edgeY);

        // The edge can change axis, not just size — re-apply orientation and the
        // scrolling axis so a left↔bottom switch doesn't keep the old ones.
        const sf = this._scaleFactor;
        this._setOrientation(this._box, vertical);
        this._box.x_align = vertical ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
        this._box.y_align = vertical ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
        this._box.set_style(vertical
            ? `padding: ${Math.round(24 * sf)}px 0px; spacing: ${Math.round(10 * sf)}px;`
            : `padding: 0px ${Math.round(24 * sf)}px; spacing: ${Math.round(10 * sf)}px;`);
        this._scroll.hscrollbar_policy = vertical ? St.PolicyType.NEVER : St.PolicyType.EXTERNAL;
        this._scroll.vscrollbar_policy = vertical ? St.PolicyType.EXTERNAL : St.PolicyType.NEVER;

        // Drop any in-flight slide first — it's aimed at the old edge and
        // would otherwise leave the panel at a stale offset.
        this._panel.remove_all_transitions();
        this._panel.set_size(panelW, panelH);
        this._panel.set_position(...(this._visible
            ? this._panelVisiblePos(mon, topH)
            : this._panelHiddenPos(mon, topH)));
        this._panel.visible = this._visible;   // the dropped slide-out never hid it
        this._scroll.set_size(panelW, panelH);
        this._syncEdge();

        if (this._visible) this._refresh();
        this._scheduleCoverCheck();
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
        this._sig(global.window_manager, 'size-change', (_wm, actor, change) => {
            const win = actor?.meta_window;
            if (win) this._onWindowSizeChange(win, change);
        });

        this._sig(global.display, 'notify::focus-window', () => {
            this._parkIfDesktopFocused();
            this._scheduleRefresh();
            this._scheduleCoverCheck();
        });
        this._sig(global.workspace_manager, 'active-workspace-changed', () => {
            this._initGroups();
            this._scheduleCoverCheck();
        });
        // Anything that moves, resizes, shows or hides a window can cover or
        // uncover the sidebar's area; each schedules one debounced check.
        for (const sig of ['map', 'destroy', 'minimize', 'unminimize', 'size-change'])
            this._sig(global.window_manager, sig, () => this._scheduleCoverCheck());
        this._sig(global.display, 'grab-op-end', () => this._scheduleCoverCheck());
        // Restacks follow every close, restore and new window, including the ones
        // the wm hooks above miss; the refresh re-checks stage membership (_reconcile).
        this._sig(global.display, 'restacked', () => this._scheduleRefresh());
        // Bare wallpaper: the press bubbles from MetaBackgroundActor to the stage (not
        // window_group, which isn't reactive). Own owner: _cancelAppDrag() drops every
        // stage handler owned by `this`.
        global.stage.connectObject('button-press-event', (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY &&
                global.stage.get_event_actor(event) instanceof Meta.BackgroundActor)
                this._parkOnDesktopClick();
            return Clutter.EVENT_PROPAGATE;
        }, this._wallpaperOwner);
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

        this._sig(this._settings, 'changed::sidebar-reserve-space', () => {
            this._applyChrome();
            this._scheduleCoverCheck();
        });
        this._sig(this._settings, 'changed::sidebar-hide-when-covered', () => this._scheduleCoverCheck());
        this._sig(this._settings, 'changed::sidebar-mode', () => {
            this._initGroups();
            if (this._visible) this._refresh();
        });
        this._sig(this._settings, 'changed::app-merge-map', () => {
            this._loadAppMergeMap();
            if (this._visible) this._refresh();
        });

        this._sig(this._settings, 'changed::sidebar-width', () => this._rebuildLayout());
        this._sig(this._settings, 'changed::edge-trigger-width', () => this._rebuildLayout());
        this._sig(this._settings, 'changed::stack-panel-position', () => this._rebuildLayout());
        this._sig(this._settings, 'changed::sidebar-auto-hide', () => {
            if (this._effectiveAutoHide()) {
                if (!this._hovered && !this._shouldForceShow()) this._scheduleHide();
                else if (this._shouldForceShow()) this._show();
            } else {
                this._show();
            }
            this._applyChrome();
        });
        this._sig(this._settings, 'changed::show-on-empty-workspace', () => {
            this._syncForceShow();
        });
        this._sig(this._settings, 'changed::show-app-icons', () => {
            if (this._visible) this._refresh();
        });
        this._sig(this._settings, 'changed::show-group-count', () => {
            if (this._visible) this._refresh();
        });
        this._sig(this._settings, 'changed::show-workspace-current', () => {
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
        this._reconcile();

        if (this._visible) this._refresh();
        this._syncForceShow();
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
            this._groups.push({ id: this._nextGid++, ws, windows: new Set(wins), fromMinimize: true });
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
            this._groups.push({ id: this._nextGid++, ws, windows: new Set([win]), fromMinimize: true, parkedAt: ++this._parkSeq });
    }

    /** Re-check stage membership against the windows themselves. mutter skips the wm
     *  hooks this file listens to during a workspace switch, so a window restored,
     *  minimized or opened then arrives with no signal; this catches it up. */
    _reconcile() {
        if (this._settings.get_string('sidebar-mode') !== 'groups') return;
        this._reapMovedWindows();
        for (const win of this._groups.flatMap(g => [...g.windows])) {
            const group = this._findGroupForWindow(win);
            // Mid-swap windows already sit where the swap put them, and one that
            // can't be minimized stays on screen whichever stage holds it.
            if (!group || this._expectMinimize.has(win) || this._expectUnminimize.has(win) ||
                !win.can_minimize()) continue;
            const active = this._isActiveGroup(group);
            if (win.minimized && active) this._onWindowMinimize(win);
            else if (!win.minimized && !active) this._onWindowUnminimize(win);
        }
        const ws = this._activeWs();
        if (ws) this._adoptStrayWindows(ws);
    }

    /** Plain data for the lock screen, which disables extensions: stable sequences
     *  only (valid for the whole login), so no window is held while disabled. */
    exportState() {
        return {
            stack: {
                groups: this._groups.map(g => ({
                    seqs: [...g.windows].map(w => w.get_stable_sequence()),
                    active: this._isActiveGroup(g),
                    fromMinimize: !!g.fromMinimize,
                    parkedAt: g.parkedAt ?? 0,
                })),
                maxOrigin: [...this._maxOrigin].map(([w, id]) =>
                    [w.get_stable_sequence(), this._groups.findIndex(g => g.id === id)]),
            },
        };
    }

    /** Rebuild the stages exportState() saved; _initGroups() then catches up on
     *  anything that changed meanwhile. A stage lives where its first window is now. */
    _restoreGroups(saved) {
        const bySeq = new Map(global.display.list_all_windows().map(w => [w.get_stable_sequence(), w]));
        const ids = saved.groups.map(s => {
            const wins = s.seqs.map(q => bySeq.get(q)).filter(w => _isNormal(w) && w.get_workspace());
            const ws = wins[0]?.get_workspace();
            if (!ws) return -1;
            const g = { id: this._nextGid++, ws, windows: new Set(wins.filter(w => w.get_workspace() === ws)) };
            if (s.fromMinimize) g.fromMinimize = true;
            g.parkedAt = s.parkedAt;
            this._parkSeq = Math.max(this._parkSeq, s.parkedAt);
            this._groups.push(g);
            if (s.active && !this._activeIds.has(ws)) this._activeIds.set(ws, g.id);
            return g.id;
        });
        for (const [seq, i] of saved.maxOrigin) {
            const win = bySeq.get(seq);
            if (win && ids[i] >= 0) this._maxOrigin.set(win, ids[i]);
        }
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

    /** Parked stages that get a card. Past MAX_GROUPS, those parked most recently,
     *  so the stage just left or the window just minimized is never the one folded away. */
    _shownInactiveGroups(all = this._getInactiveGroups()) {
        if (all.length <= MAX_GROUPS) return all;
        const newest = new Set([...all].sort((a, b) => (b.parkedAt ?? 0) - (a.parkedAt ?? 0)).slice(0, MAX_GROUPS));
        return all.filter(g => newest.has(g));
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

    // ── App merge/un-merge ('apps' mode) ─────────────────────────────

    _loadAppMergeMap() {
        const raw = this._settings.get_string('app-merge-map');
        let obj = {};
        // JSON.parse genuinely throws on malformed input (hand-edited dconf) —
        // the one deliberate exception to this file's zero-try-catch rule.
        try { obj = JSON.parse(raw); } catch (_e) { obj = {}; }
        this._appMergeMap = new Map(Object.entries(obj));
    }

    _saveAppMergeMap() {
        const obj = Object.fromEntries(this._appMergeMap);
        this._settings.set_string('app-merge-map', JSON.stringify(obj));
    }

    /** Point sourceAppId at targetKey, flattening anyone already pointing at
     *  sourceAppId onto targetKey — keeps every entry a single hop. Map-only; callers save once. */
    _applyMerge(sourceAppId, targetKey) {
        if (sourceAppId === targetKey) return;
        this._appMergeMap.set(sourceAppId, targetKey);
        for (const [appId, key] of [...this._appMergeMap]) {
            if (key === sourceAppId) this._appMergeMap.set(appId, targetKey);
        }
    }

    _mergeApp(sourceAppId, targetKey) {
        this._applyMerge(sourceAppId, targetKey);
        this._saveAppMergeMap();
    }

    _unmergeGroup(group) {
        if (group.apps.length <= 1) return;
        for (const app of group.apps) this._appMergeMap.delete(app.get_id());
        this._saveAppMergeMap();
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

    /** Sweep every stage for windows that closed, changed workspace, or stopped
     *  being stage material (stuck to all workspaces, say). */
    _reapMovedWindows() {
        // No workspace = closed. mutter runs the wm 'destroy' hook only for a window
        // on screen, so one closed while parked never reached _onWindowDestroy().
        for (const win of this._groups.flatMap(g => [...g.windows]))
            if (!win.get_workspace()) this._onWindowDestroy(win);
        for (const group of this._groups) {
            for (const win of [...group.windows]) {
                if (this._workspaceOf(win) !== group.ws || !_isNormal(win)) group.windows.delete(win);
            }
        }
        this._cleanupEmptyGroups();
    }

    _cleanupEmptyGroups(keep = null) {
        this._groups = this._groups.filter(g => g.windows.size > 0 || g === keep);
        for (const [ws, id] of [...this._activeIds]) {
            if (!this._groups.some(g => g.id === id)) this._activeIds.delete(ws);
        }
    }

    _onWindowMinimize(win) {
        if (!_isNormal(win)) return;
        // Our own swap minimized this one — consume it, it is not the user
        // parking a window.
        if (this._expectMinimize.delete(win)) return;

        if (this._settings.get_string('sidebar-mode') === 'groups') {
            const ws = this._workspaceOf(win);
            this._evictIfMoved(win);
            const group = this._findGroupForWindow(win);
            if (!group) {
                // Held by no stage — park it as its own stage on the workspace it lives on.
                if (ws) this._groups.push({ id: this._nextGid++, ws, windows: new Set([win]), fromMinimize: true, parkedAt: ++this._parkSeq });
            } else if (this._isActiveGroup(group)) {
                group.windows.delete(win);
                this._groups.push({ id: this._nextGid++, ws: group.ws, windows: new Set([win]), fromMinimize: true, parkedAt: ++this._parkSeq });
                this._cleanupEmptyGroups();
            }
        }
        this._scheduleRefresh();
        this._syncForceShow();
    }

    _onWindowUnminimize(win) {
        if (!_isNormal(win)) return;
        if (this._expectUnminimize.delete(win)) return;

        if (this._settings.get_string('sidebar-mode') === 'groups') {
            const ws = this._workspaceOf(win);
            if (!ws) return;
            this._evictIfMoved(win);
            const group = this._findGroupForWindow(win);
            // Restored from the dock or alt-tab: a window from a parked STAGE
            // brings its whole stage forward, as on macOS; pulling it in alone
            // split that stage apart. One minimized on its own just rejoins.
            if (group && !this._isActiveGroup(group) && !group.fromMinimize &&
                group.ws === this._activeWs()) {
                this._swapToGroup(group, win);
                this._syncForceShow();
                return;
            }
            if (group && !this._isActiveGroup(group)) group.windows.delete(win);
            this._ensureActiveGroup(ws).windows.add(win);
            this._cleanupEmptyGroups();
        }
        this._scheduleRefresh();
        this._syncForceShow();
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
        this._syncForceShow();
    }

    /** Opt-in (issue #10): maximizing gives a window a stage of its own and
     *  parks its former stage-mates as a card; unmaximizing returns it.
     *  Groups mode only — apps/workspaces modes derive their stages elsewhere. */
    _onWindowSizeChange(win, change) {
        if (!_isNormal(win)) return;
        // Only the outbound promotion is gated (same rule as maximize-to-
        // workspace): a window promoted earlier must still get home if the
        // setting or the mode changed while it was maximized.
        if (change === Meta.SizeChange.UNMAXIMIZE) { this._returnFromOwnGroup(win); return; }
        if (change !== Meta.SizeChange.MAXIMIZE) return;

        // One enum, so 'workspace' and 'stage' can no longer both fire — which
        // used to park the stage-mates and then strand an empty stage.
        if (this._settings.get_string('maximize-behavior') !== 'stage') return;
        if (this._settings.get_string('sidebar-mode') !== 'groups') return;
        this._promoteToOwnGroup(win);
    }

    _promoteToOwnGroup(win) {
        const group = this._findGroupForWindow(win);
        // Already alone on its stage — promoting would just renumber it.
        if (!group || this._groupWindows(group).length < 2) return;
        // _swapToGroup only acts on the active workspace, so promoting a
        // background stage would split it and never park anything.
        if (group.ws !== this._activeWs()) return;

        group.windows.delete(win);
        this._maxOrigin.set(win, group.id);
        const promoted = { id: this._nextGid++, ws: group.ws, windows: new Set([win]) };
        this._groups.push(promoted);
        this._swapToGroup(promoted);
    }

    _returnFromOwnGroup(win) {
        const originId = this._maxOrigin.get(win);
        if (originId === undefined) return;
        this._maxOrigin.delete(win);

        const origin = this._groups.find(g => g.id === originId);
        // The origin stage can be gone (its windows were all closed) or the
        // window dragged away since — leave it where it is rather than rebuild.
        if (!origin || origin.ws !== this._workspaceOf(win)) return;

        const promoted = this._findGroupForWindow(win);
        // Read before _cleanupEmptyGroups drops the emptied stage and its active id.
        const onPromoted = this._isActiveGroup(promoted);
        promoted?.windows.delete(win);
        origin.windows.add(win);
        this._cleanupEmptyGroups();
        // Only follow the window home if the user is still on its stage —
        // unmaximizing a parked window is bookkeeping, not a navigation request.
        if (onPromoted) this._swapToGroup(origin);
        else this._scheduleRefresh();
    }

    _onWindowDestroy(win) {
        this._expectMinimize.delete(win);
        this._expectUnminimize.delete(win);
        this._maxOrigin.delete(win);
        for (const group of this._groups) {
            group.windows.delete(win);
        }
        this._cleanupEmptyGroups();
        this._scheduleRefresh();
        this._syncForceShow();
    }

    _swapToGroup(targetGroup, focusWin = null) {
        const ws = this._activeWs();
        if (!targetGroup || targetGroup.ws !== ws) return;
        if (targetGroup.id === this._activeIds.get(ws)) return;

        this._destroyPreview();

        const activeGroup = this._getActiveGroup(ws);
        if (activeGroup) {
            activeGroup.parkedAt = ++this._parkSeq;
            for (const win of this._groupWindows(activeGroup)) {
                // mutter refuses (with a warning) a window that can't be minimized.
                if (!win.minimized && win.can_minimize()) {
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

        const front = focusWin ?? targetWins[0];
        if (front) front.activate(global.get_current_time());

        this._activeIds.set(ws, targetGroup.id);
        // Once shown as a stage it is one; parked again later it swaps back whole.
        delete targetGroup.fromMinimize;
        // Swaps consume their own minimize signals, so nothing else drops a left Show Desktop placeholder.
        this._cleanupEmptyGroups(targetGroup);

        // Safety net only: a compositor that refuses a minimize would otherwise
        // leave a stale expectation behind that swallows the user's next one.
        this._killSwapTimer();
        this._swapTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._untrackTimer(this._swapTimer); this._swapTimer = null;
            this._expectMinimize.clear();
            this._expectUnminimize.clear();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._swapTimer);

        this._hovered = false;
        // Reuses the single _refreshTimer slot, so a swap refresh and a debounced
        // refresh can never both be queued. EGO-L-007: the remove is inlined
        // rather than going through _killRefreshTimer(), because shexli only
        // recognises it when it sits textually adjacent to the re-arm.
        if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._untrackTimer(this._refreshTimer); this._refreshTimer = null; }
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._untrackTimer(this._refreshTimer); this._refreshTimer = null;
            if (this._visible) this._refresh();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._refreshTimer);

        if (this._effectiveAutoHide() && !this._shouldForceShow())
            this._scheduleHide();
    }

    // ── Fullscreen ──

    _fullscreen() {
        return global.display.get_monitor_in_fullscreen(_getMon().index);
    }

    _onFullscreen() {
        if (this._fullscreen()) {
            this._destroyPreview();
            if (this._visible) {
                this._visible = false;
                if (this._panel) {
                    this._panel.remove_all_transitions();
                    const m = _getMon();
                    this._panel.set_position(
                        ...this._panelHiddenPos(m, Main.panel ? Main.panel.height : 0));
                    this._panel.hide();
                }
            }
            this._syncEdge();
            this._applyChrome();
        } else {
            this._syncEdge();
            // An always-visible sidebar has to come back on its own; it used to
            // stay hidden until the user happened to brush the screen edge.
            if (!this._effectiveAutoHide() || this._shouldForceShow())
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
        Main.wm.addKeybinding(
            SHOW_DESKTOP_KEYBIND,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._showDesktop(),
        );
        this._keybindingAdded = true;
    }

    _removeKeybinding() {
        if (!this._keybindingAdded) return;
        Main.wm.removeKeybinding(KEYBIND_NAME);
        Main.wm.removeKeybinding(SHOW_DESKTOP_KEYBIND);
        this._keybindingAdded = false;
    }

    _toggleVisible() {
        if (this._visible) this._hide();
        else this._show();
    }

    /** macOS "Show Desktop": park the current stage (or every window) so the
     *  wallpaper is revealed, leaving the sidebar up with all stages as cards. */
    _showDesktop() {
        const ws = this._activeWs();
        if (!ws) return;

        if (this._settings.get_string('sidebar-mode') === 'groups') {
            const active = this._getActiveGroup(ws);
            if (!active || this._groupWindows(active).every(w => w.minimized)) return;
            // Swap to a fresh empty stage — _swapToGroup parks the old stage as
            // one card instead of splitting it per-window the way minimize does.
            const empty = { id: this._nextGid++, ws, windows: new Set() };
            this._groups.push(empty);
            this._swapToGroup(empty);
            // Its minimizes are expected ones, which skip this: bring the sidebar up.
            this._syncForceShow();
            return;
        }

        for (const win of ws.list_windows()) {
            if (_isNormal(win) && !win.minimized) win.minimize();
        }
        this._syncForceShow();
    }

    // ── Show / Hide ──

    // `_visible` alone gates entry — no separate `_animating` flag. Gating on
    // one meant a pointer returning mid-slide-out was dropped with nothing to retry.
    _show() {
        if (this._visible || !this._panel) return;
        if (this._fullscreen()) return;

        this._visible = true;
        this._refresh();
        // AFTER the refresh, which re-arms the hide when the pointer is away.
        // An explicit reveal (keybinding, force-show, edge dwell) must win, or
        // it would hide itself again a moment later without the user acting.
        this._killHideTimer();
        this._syncEdge();

        const [vx, vy] = this._panelVisiblePos(_getMon(), Main.panel ? Main.panel.height : 0);
        this._panel.remove_all_transitions();
        this._panel.show();
        this._panel.ease({
            x: vx, y: vy,
            duration: this._animMs(this._SLIDE_MS),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            // Claimed only once settled — mid-slide would resize every window on every frame.
            onComplete: () => this._applyChrome(),
        });
    }

    _hide() {
        if (!this._visible || !this._panel) return;

        this._visible = false;
        this._killHideTimer();
        this._destroyPreview();
        this._syncEdge();
        // Give the space back before moving, so windows reflow once rather than
        // tracking the panel across the screen.
        this._applyChrome();
        // Drop the fingerprint so the next reveal replays the entrance animation
        // instead of showing stale cards.
        this._signature = null;

        const [hx, hy] = this._panelHiddenPos(_getMon(), Main.panel ? Main.panel.height : 0);
        this._panel.remove_all_transitions();
        this._panel.ease({
            x: hx, y: hy,
            duration: this._animMs(this._SLIDE_MS),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            // Off its monitor the panel can sit on the next one, still drawn and clickable.
            onComplete: () => this._panel?.hide(),
        });
    }

    _scheduleHide() {
        // Never hide when force-show is active (empty desktop override).
        if (this._shouldForceShow()) return;
        this._killHideTimer();
        this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._HIDE_DELAY_MS, () => {
            // Pointer still over the sidebar's area: keep waiting. Geometry,
            // not _hovered, so a stale hover flag can never pin it open, and a
            // reveal the pointer never entered a card of still recedes.
            if (this._pointerOverPanel()) return GLib.SOURCE_CONTINUE;
            this._untrackTimer(this._hideTimer); this._hideTimer = null;
            if (!this._shouldForceShow()) this._hide();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._hideTimer);
    }

    _scheduleRefresh() {
        // EGO-L-007: must remove any in-flight timer before re-arming. Inlined
        // (not via _killRefreshTimer) — shexli wants the remove textually adjacent.
        if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._untrackTimer(this._refreshTimer); this._refreshTimer = null; }
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._untrackTimer(this._refreshTimer); this._refreshTimer = null;
            this._reconcile();
            if (this._visible && !this._hovered) this._refresh();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._refreshTimer);
    }

    // ── Render ──────────────────────────────────────────────────────────

    _refresh() {
        if (!this._box) return;

        // Nothing to redraw? Then don't — every rebuild recreates a window clone
        // per thumbnail, and this runs on every focus change.
        const signature = this._renderSignature();
        if (signature === this._signature) return;
        this._signature = signature;

        // Cards about to be destroyed may be under the pointer with no leave-event
        // coming, so re-derive hover from the pointer instead of assuming it left.
        // Blindly clearing it stranded the sidebar open: nothing was left to
        // fire a leave-event, and nothing re-armed the hide timer.
        this._killHoverTimer();
        this._destroyPreview();
        this._hovered = this._pointerOverPanel();

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

        // The rebuild consumed any pending leave-event, so if the pointer is
        // away the hide has to be re-armed here or the sidebar stays up.
        if (!this._hovered && this._visible &&
            this._effectiveAutoHide())
            this._scheduleHide();
    }

    /** Fingerprint of everything _refresh() would draw, so a refresh is skipped
     *  when the result would be pixel-identical. */
    _renderSignature() {
        const mode = this._settings.get_string('sidebar-mode');
        const parts = [
            mode, this._scaleFactor, this._themeClass, this._PANEL_W, this._POS,
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
            const groups = _groupByApp(this._activeWs(), global.display.get_focus_window(), this._appMergeMap);
            for (const g of groups)
                parts.push(`${g.key}:${ids(g.windows)}`);
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
            const all = this._getInactiveGroups();
            for (const g of this._shownInactiveGroups(all))
                parts.push(`${g.id}:${ids(this._groupWindows(g))}`);
            parts.push(all.length);
        }
        return parts.join('|');
    }

    _refreshGroups() {
        // Inactive STAGES, not apps: clicking one swaps to it (_swapToGroup).
        // Rendering apps here made this mode a duplicate of 'apps' and left the
        // swap unreachable, and its user-time ordering rebuilt every card on
        // each focus change.
        const all = this._getInactiveGroups();
        for (const group of this._shownInactiveGroups(all)) {
            const card = this._makeGroupCard(group);
            if (card) { this._box.add_child(card); this._cards.push(card); }
        }
        this._addOverflowLabel(all.length - MAX_GROUPS);
    }

    _refreshApps() {
        const focusedWin = global.display.get_focus_window();
        const all = _groupByApp(this._activeWs(), focusedWin, this._appMergeMap);
        for (const group of all.slice(0, MAX_GROUPS)) {
            const card = this._makeAppCard(group);
            if (card) { this._box.add_child(card); this._cards.push(card); }
        }
        this._addOverflowLabel(all.length - MAX_GROUPS);
    }

    /** Every window on every workspace, one card each. Deliberately read-only —
     *  never minimizes/regroups/moves a window; click just activates and lets mutter switch workspace. */
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
        const text = _('Workspace %d').replace('%d', `${wsIndex + 1}`);
        if (this._box)
            this._box.add_child(new St.Label({
                text, reactive: false,
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
        if (this._effectiveAutoHide()) this._scheduleHide();
        this._scheduleRefresh();
    }

    /** Show "+N" for stages beyond MAX_GROUPS instead of dropping them silently.
     *  Not pushed to `_cards` — it's a label, not a hover/bell-curve target. */
    _addOverflowLabel(hidden) {
        if (hidden <= 0) return;
        if (!this._box) return;
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
        const angle = this._PERSP_ANGLE * this._ROT_SIGN;

        for (let i = 0; i < this._cards.length; i++) {
            const card = this._cards[i];

            // Start invisible, shifted down
            card.set_opacity(0);
            card.translation_y = 24;
            card.set_scale(base * 0.82, base * 0.82);

            // Perspective goes on the CARD, not the thumbnail — rotating only the
            // child let content spill outside the card's pill background. A bottom
            // strip tilts around X so the cards still lean into the screen.
            if (this._VERTICAL) card.rotation_angle_y = angle;
            else card.rotation_angle_x = angle;

            card.ease({
                opacity: CARD_REST_OPACITY,
                translation_y: 0,
                scale_x: base,
                scale_y: base,
                duration: this._animMs(220),
                delay: this._REDUCED_MOTION ? 0 : i * 32,
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
        // Always vertical: the icon row sits under the thumbnail whatever edge
        // the panel is on — only the card *column* changes axis.
        this._setOrientation(card, true);
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
        const { windows } = group;
        const card = this._wrapCard();
        // Tagged so _appCardGroupAtPointer() can resolve a drag's drop target
        // by hit-testing, without trusting which card's own handler fired.
        card._group = group;
        const thumb = this._makeStackedThumb(windows);
        card.add_child(thumb);
        card._thumb = thumb;

        if (this._settings.get_boolean('show-app-icons') && group.apps.length > 0) {
            const seenApps = new Set();
            const iconBox = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                style: 'margin-top: 5px; spacing: 4px;',
            });
            for (const a of group.apps) {
                if (!seenApps.has(a.get_id())) {
                    seenApps.add(a.get_id());
                    iconBox.add_child(a.create_icon_texture(ICON_SIZE));
                }
            }
            card.add_child(iconBox);
        }

        card.set_pivot_point(0.5, 0.5);
        const idx = this._cards.length;
        this._wireCardEvents(card, thumb, windows, idx);

        this._cardSig(card, 'button-press-event', (_a, event) => {
            if (event.get_button() === 3 && group.apps.length > 1) {
                this._unmergeGroup(group);
                return Clutter.EVENT_STOP;
            }
            if (event.get_button() === 1) this._startAppDragCandidate(group, card);
            return Clutter.EVENT_PROPAGATE;
        });
        this._cardSig(card, 'button-release-event', () => {
            this._destroyPreview();
            if (this._endAppDragCandidate()) return Clutter.EVENT_STOP;
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
        if (this._effectiveAutoHide()) this._scheduleHide();
        this._scheduleRefresh();
    }

    /** Aspect-correct clone of win's whole compositor actor (shadow included,
     *  never cropped), scaled to fit maxW×maxH and capped at maxScale. */
    _makeWindowClone(win, maxW, maxH, maxScale = Infinity) {
        // A live clone works for minimized windows too, as in alt-tab; no actor
        // (or no size yet) leaves the caller's icon fallback.
        const geom = this._windowGeometry(win);
        if (!geom) return null;

        const { aw, ah } = geom;
        const scale = Math.min(maxW / aw, maxH / ah, maxScale);

        const inner = new Clutter.Clone({ source: geom.actor, reactive: false });
        inner.set_size(Math.round(aw * scale), Math.round(ah * scale));
        return inner;
    }

    /** Size of `win`'s compositor actor — the whole thing, shadow included. */
    _windowGeometry(win) {
        const actor = win.get_compositor_private?.();
        if (!actor) return null;

        const [aw, ah] = actor.get_size();
        if (!(aw > 0) || !(ah > 0)) return null;

        return { aw, ah, actor };
    }

    /** Clamp an aspect ratio into the range a card can sensibly display. */
    _clampAspect(ratio) {
        if (!(ratio > 0)) return null;
        return Math.min(THUMB_ASPECT_MAX, Math.max(THUMB_ASPECT_MIN, ratio));
    }

    /** Shape of what will actually be drawn, so the window fills its card
     *  (frame rect is only a fallback for a window with no actor yet). */
    _windowAspect(win) {
        const geom = this._windowGeometry(win);
        if (geom) return this._clampAspect(geom.aw / geom.ah);
        const r = win.get_frame_rect();
        if (r && r.width > 0 && r.height > 0)
            return this._clampAspect(r.width / r.height);
        return null;
    }

    /** Shape of the display — what a maximized window looks like. */
    _monitorAspect() {
        const mon = _getMon();
        return (mon && this._clampAspect(mon.width / mon.height)) ??
               this._clampAspect(THUMB_W / THUMB_H);
    }

    /** Thumbnail size for a stack of `count` windows, derived from the sidebar
     *  width — a fixed THUMB_W doesn't fit once fan-out + card padding are added. */
    _thumbSize(count, aspect = null) {
        const sf = this._scaleFactor;
        const layers = Math.min(Math.max(count, 1), MAX_STACK);
        const perspective = 1 + (this._PERSP_ANGLE / 45) * PERSP_HEADROOM;
        const ratio = aspect ?? this._monitorAspect();

        // Fan-out is a fraction of the thumbnail, not a fixed offset, so
        // `size + (layers-1)·size·k ≤ budget` always has a solution.
        if (!this._VERTICAL) {
            // Bottom strip: the panel's thickness caps the HEIGHT, and width
            // follows the aspect. The icon row sits below the thumb, so it comes
            // out of the same budget.
            const iconRow = this._settings.get_boolean('show-app-icons')
                ? (ICON_SIZE + 5) * sf : 0;
            const budgetH = (this._PANEL_W - CARD_MARGIN * sf) / perspective -
                            2 * CARD_PAD_Y * sf - iconRow;
            const kv = STACK_V / THUMB_W;
            const fittedH = budgetH / (1 + (layers - 1) * kv);
            const h = Math.round(Math.max(MIN_THUMB_W * sf / THUMB_ASPECT_MAX, fittedH));
            return [Math.round(h * ratio), h];
        }

        const budget = (this._PANEL_W - CARD_MARGIN * sf) / perspective - 2 * CARD_PAD_X * sf;
        const k = STACK_H / THUMB_W;
        const fitted = budget / (1 + (layers - 1) * k);

        // No upper cap: a wider sidebar is a request for bigger cards.
        const w = Math.round(Math.max(MIN_THUMB_W * sf, fitted));
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
            if (this._effectiveAutoHide()) this._scheduleHide();
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
        const angle = this._PERSP_ANGLE * this._ROT_SIGN;
        for (const card of this._cards) {
            card.ease({
                scale_x: base, scale_y: base,
                opacity: CARD_REST_OPACITY,
                ...this._rotProp(angle),
                duration: this._animMs(150),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /** Bell curve: hovered card scales to 1.0 and goes flat; only 1-2 neighbors
     *  are affected (tight sigma). */
    _applyBellCurve(hoveredIdx) {
        const base = this._BASE_SCALE;
        const angle = this._PERSP_ANGLE * this._ROT_SIGN;

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
                ...this._rotProp(rot),
                duration: this._animMs(150),
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
            this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                this._untrackTimer(this._hoverTimer); this._hoverTimer = null;
                this._showPreview(card, windows);
                return GLib.SOURCE_REMOVE;
            });
            this._timers.push(this._hoverTimer);
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
                if (this._effectiveAutoHide())
                    this._scheduleHide();
            }
        });
    }

    // ── Preview ─────────────────────────────────────────────────────────

    /** Larger preview of ALL windows in the group, tiled vertically. Falls back
     *  to an icon grid when no compositor actors are available. */
    _showPreview(card, windows) {
        this._destroyPreview();

        const mon = _getMon();
        const topH = Main.panel ? Main.panel.height : 0;
        const [cardX, cardY] = card.get_transformed_position();

        // Collect windows that have compositor actors (cloneable)
        const cloneable = windows.filter(w => !!w.get_compositor_private());

        if (cloneable.length === 0) {
            this._showIconPreview(windows, cardX, cardY);
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
            this._showIconPreview(windows, cardX, cardY);
            return;
        }

        totalH -= gap; // remove trailing gap
        const previewW = maxCloneW + padding * 2;
        const previewH = totalH;

        this._preview = new St.Widget({
            style_class: this._cls('stage-preview'),
            reactive: false,
        });
        this._preview.set_size(previewW, previewH);
        this._preview.set_position(
            ...this._previewPos(mon, topH, previewW, previewH, 8 * sf, cardX, cardY));

        let yOff = padding;
        for (const holder of clones) {
            holder.set_position(padding + (maxCloneW - holder.width) / 2, yOff);
            this._preview.add_child(holder);
            yOff += holder.height + gap;
        }

        Main.layoutManager.addChrome(this._preview, { trackFullscreen: false });
        this._preview.set_opacity(0);
        this._preview.ease({ opacity: 255, duration: this._animMs(150), mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    /** Fallback preview: app icons + names when clones aren't available. */
    _showIconPreview(windows, cardX, cardY) {
        const tracker = Shell.WindowTracker.get_default();
        const mon = _getMon();
        const topH = Main.panel ? Main.panel.height : 0;
        const sf = this._scaleFactor;

        const previewW = 220 * sf;
        const previewH = 160 * sf;

        this._preview = new St.Widget({
            style_class: this._cls('stage-preview'),
            reactive: false,
        });
        this._preview.set_size(previewW, previewH);
        this._preview.set_position(
            ...this._previewPos(mon, topH, previewW, previewH, 8, cardX, cardY));

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
        this._preview.ease({ opacity: 255, duration: this._animMs(150), mode: Clutter.AnimationMode.EASE_OUT_QUAD });
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

    _untrackTimer(id) {
        const i = this._timers.indexOf(id);
        if (i >= 0) this._timers.splice(i, 1);
    }

    _killRefreshTimer() {
        if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._untrackTimer(this._refreshTimer); this._refreshTimer = null; }
    }

    _killHideTimer() {
        if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._untrackTimer(this._hideTimer); this._hideTimer = null; }
    }

    _killHoverTimer() {
        if (this._hoverTimer) { GLib.source_remove(this._hoverTimer); this._untrackTimer(this._hoverTimer); this._hoverTimer = null; }
    }

    _killSwapTimer() {
        if (this._swapTimer) { GLib.source_remove(this._swapTimer); this._untrackTimer(this._swapTimer); this._swapTimer = null; }
    }

    _killEdgeTimer() {
        if (this._edgeTimer) { GLib.source_remove(this._edgeTimer); this._untrackTimer(this._edgeTimer); this._edgeTimer = null; }
    }

    _killCoverTimer() {
        if (this._coverTimer) { GLib.source_remove(this._coverTimer); this._untrackTimer(this._coverTimer); this._coverTimer = null; }
    }

    _killDeskTimer() {
        if (this._deskTimer) { GLib.source_remove(this._deskTimer); this._untrackTimer(this._deskTimer); this._deskTimer = null; }
    }

    // ── Show-on-empty-workspace ──────────────────────────────────────────

    /**
      * Whether the active workspace has any visible (non-minimized) normal
      * windows. Returns false when every window is minimized, i.e. the user
      * is looking at bare wallpaper.
      */
    _wsHasVisibleWindows() {
        const ws = this._activeWs();
        if (!ws) return false;
        return ws.list_windows().some(w => _isNormal(w) && !w.minimized);
    }

    /**
      * Whether the sidebar should be force-shown right now, overriding
      * auto-hide. True only when ALL of:
      *   1. The 'show-on-empty-workspace' setting is on.
      *   2. The sidebar is enabled.
      *   3. The active workspace has no visible (non-minimized) normal windows.
      * Works in all 3 sidebar modes (groups, apps, workspaces).
      */
    _shouldForceShow() {
        return this._settings.get_boolean('show-on-empty-workspace') &&
            !this._wsHasVisibleWindows();
    }

    /**
      * Re-evaluate whether force-show should kick in or recede. Called on
      * every state change that could flip the answer: workspace switch,
      * minimize, unminimize, window map/destroy, and setting toggle.
      */
    _syncForceShow() {
        if (this._fullscreen()) return;

        if (this._shouldForceShow()) {
            // Empty desktop — make sure sidebar is visible.
            this._killHideTimer();
            if (!this._visible) this._show();
        } else if (this._effectiveAutoHide() &&
            this._visible && !this._hovered) {
            // Desktop is no longer empty and auto-hide is on — recede.
            this._scheduleHide();
        }
    }
}


// ─── ArcSidebar ─────────────────────────────────────────────────────────────
// Carousel-style sidebar; owns its own actors/settings/timers/signals, never
// shares state with StageSidebar. Spec: docs/superpowers/specs/2026-07-30-arc-sidebar-design.md.

const ARC_BASE_GRID_W    = 158;
const ARC_BASE_GRID_H    = 89;
const ARC_BASE_ICON_SIZE = 42;
const ARC_ICON_OVL       = 20;
const ARC_PAD_H          = 12;
const ARC_MAX_ANGLE      = 84;   // arc span from the front card (deg)
const ARC_FADE_START     = 60;   // cards closer than this stay fully opaque
const ARC_SCROLL_FRICTION = 0.82;
const ARC_SCROLL_MIN_VEL  = 0.005;
const ARC_DRAG_THRESHOLD  = 18;   // logical px — scaled by _scaleFactor before use
const ARC_GHOST_SIZE      = 100;  // logical px — scaled by _scaleFactor before use
const ARC_RADIUS_RATIO   = 0.48;  // fraction of workarea height/width
const ARC_MIN_RADIUS     = 200;   // logical px floor for a degenerate (very short) workarea

// How long Arc stays out when it first appears, so users see where it lives.
const ARC_PEEK_MS = 3000;

const ARC_KEYBINDINGS = [
    'toggle-sidebar',
    'keybinding-show-desktop',
    'keybinding-arc-next',
    'keybinding-arc-prev',
    'keybinding-arc-activate',
    'keybinding-arc-close',
];

class ArcSidebar {
    /** `peek`: slide in briefly on enable (first login, or the user just
     *  switched to Arc); otherwise it sits hidden behind its edge strip. */
    constructor(settings, { peek = false, saved = null } = {}) {
        this._peekOnEnable = peek;
        this._saved = saved?.arc ?? null;   // exportState() from before the lock screen
        this._settings = settings;
        this._sigSources = new Set();
        this._cardSigSources = new Set();

        this._monitor = null;
        this._isVisible = false;
        this._persistMode = false;
        this._persistEnabled = false;
        this._scaleFactor = 1;

        this._timers = [];               // every live timeout id (drained in disable)
        this._hideTimer = null;
        this._physicsTimer = null;
        this._persistTimer = null;
        this._scrollTimer = null;
        this._refreshTimer = null;
        this._dragPollTimer = null;
        this._edgeTimer = null;          // pointer-dwell before an edge reveal
        this._fanCollapseTimer = null;   // delayed fan collapse (arc-fan-hold)
        this._newWindowTimer = null;     // batched window-created settle
        this._overviewSyncTimer = null;  // post-overview group sync
        this._pendingNewWindows = [];    // drained by _newWindowTimer

        this._groups = [];
        this._offset = 0;
        this._velocity = 0;
        this._containers = [];
        this._containerByKey = new Map(); // group key -> container (reused during scroll)
        this._drag = null;
        this._dragGhost = null;
        this._hoveredContainer = null;    // container currently under the pointer
        this._fannedGroupKey = null;      // group kept fanned across refreshes
        this._activeKey = null;           // window key of the focused window
        this._overviewActive = false;     // is the GNOME overview currently shown

        this._mergeMap = new Map();
        this._orderMap = new Map();
        this._groupStates = new Map();

        this._panel = null;
        this._edge = null;
        this._geo = null;

        this._boundKeys = [];
    }

    enable() {
        this._scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        this._monitor = this._pickMonitor();
        this._loadMergeMap();
        this._loadOrderMap();
        // Both maps are keyed by stable sequence, valid for the whole login.
        if (this._saved) {
            this._mergeMap = new Map(this._saved.merge);
            this._orderMap = new Map(this._saved.order);
        }
        this._saved = null;
        this._loadConfig();
        this._buildUI();
        this._addKeybindings();

        this._sig(global.display, 'notify::focus-window', () => {
            this._trackFocus();
            this._scheduleRefresh();
        });
        this._sig(global.display, 'window-created', (_d, win) => this._onWindowCreated(win));
        this._sig(Main.overview, 'showing', () => this._onOverviewShowing());
        this._sig(Main.overview, 'hidden', () => this._onOverviewHidden());
        this._sig(Main.layoutManager, 'monitors-changed', () => this._rebuild());
        this._sig(this._settings, 'changed', (_s, key) => {
            // arc-merge-map / arc-order-map are no longer read or written.
            if (key === 'arc-persistent-mode') {
                this._persistEnabled = this._settings.get_boolean('arc-persistent-mode');
                if (this._persistEnabled) this._armPersistTimer();
                else { this._killPersistTimer(); this._persistMode = false; }
            }
            else if (key === 'arc-hide-active') { this._scheduleRefresh(); }
            else if (key === 'arc-fan-hold' || key === 'arc-fan-hold-delay') { /* read live, nothing to rebuild */ }
            else if (ARC_KEYBINDINGS.includes(key)) { this._removeKeybindings(); this._addKeybindings(); }
            else this._rebuild();
        });

        this._sig(global.display, 'in-fullscreen-changed', () => {
            this._syncEdge();
            this._syncPanel();
        });

        this._trackFocus();
        this._scheduleRefresh();
        if (this._settings.get_boolean('arc-persistent-mode')) this._armPersistTimer();

        // Arc lives off screen behind a thin edge strip, so slide it in briefly
        // or a user who just picked it sees everything simply disappear.
        if (this._peekOnEnable) {
            this._showPanel();
            this._startHide(ARC_PEEK_MS);
        }
    }

    disable() {
        this._cancelDrag();
        this._removeKeybindings();
        this._killHideTimer();
        this._killPhysicsTimer();
        this._killScrollTimer();
        this._killPersistTimer();
        this._killRefreshTimer();
        this._killEdgeTimer();
        this._killFanCollapseTimer();
        this._killNewWindowTimer();
        this._killOverviewSyncTimer();
        this._killCardTimers();
        this._pendingNewWindows = [];
        // Anything the named fields above did not cover.
        this._timers.splice(0).forEach(id => GLib.source_remove(id));

        this._sigSources.forEach(o => o.disconnectObject(this));
        this._sigSources.clear();
        this._disconnectCardSigs();

        this._destroyUI();
        this._settings = null;
    }

    // ── Signal / timer helpers (same pattern as StageSidebar, EGO-L-003/004) ──

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

    _untrackTimer(id) {
        const i = this._timers.indexOf(id);
        if (i >= 0) this._timers.splice(i, 1);
    }

    _killHideTimer() { if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._untrackTimer(this._hideTimer); this._hideTimer = null; } }
    _killPhysicsTimer() { if (this._physicsTimer) { GLib.source_remove(this._physicsTimer); this._untrackTimer(this._physicsTimer); this._physicsTimer = null; } }
    _killScrollTimer() { if (this._scrollTimer) { GLib.source_remove(this._scrollTimer); this._untrackTimer(this._scrollTimer); this._scrollTimer = null; } }
    _killPersistTimer() { if (this._persistTimer) { GLib.source_remove(this._persistTimer); this._untrackTimer(this._persistTimer); this._persistTimer = null; } }
    _killRefreshTimer() { if (this._refreshTimer) { GLib.source_remove(this._refreshTimer); this._untrackTimer(this._refreshTimer); this._refreshTimer = null; } }
    _killDragPollTimer() { if (this._dragPollTimer) { GLib.source_remove(this._dragPollTimer); this._untrackTimer(this._dragPollTimer); this._dragPollTimer = null; } }
    _killEdgeTimer() { if (this._edgeTimer) { GLib.source_remove(this._edgeTimer); this._untrackTimer(this._edgeTimer); this._edgeTimer = null; } }
    _killNewWindowTimer() { if (this._newWindowTimer) { GLib.source_remove(this._newWindowTimer); this._untrackTimer(this._newWindowTimer); this._newWindowTimer = null; } }
    _killOverviewSyncTimer() { if (this._overviewSyncTimer) { GLib.source_remove(this._overviewSyncTimer); this._untrackTimer(this._overviewSyncTimer); this._overviewSyncTimer = null; } }

    _killCardTimers() {
        this._containers.forEach(c => this._killGridTimers(c._grid));
    }

    /** Drop a grid's fan/close timeouts. Also what its 'destroy' handler runs,
     *  so a card that goes away on its own takes its timeouts with it. */
    _killGridTimers(g) {
        if (!g) return;
        if (g._fanTimer) { GLib.source_remove(g._fanTimer); this._untrackTimer(g._fanTimer); g._fanTimer = null; }
        if (g._closeTimer) { GLib.source_remove(g._closeTimer); this._untrackTimer(g._closeTimer); g._closeTimer = null; }
    }

    _armPersistTimer() {
        this._killPersistTimer();
        this._persistTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._checkPersistence();
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.push(this._persistTimer);
    }

    // ── Filled in by later tasks ──

    _pickMonitor() { return _getMon(); }

    // Groups are keyed by _windowKey(), i.e. get_stable_sequence(), which is a
    // per-SESSION counter. Persisting that to dconf meant the numbers were
    // reused by unrelated windows after the next login, silently pre-grouping
    // them. Both maps are therefore in-memory only and reset each session; the
    // two gschema keys are kept (deprecated) so existing profiles still load.
    _loadMergeMap() {
        this._mergeMap = new Map();
    }

    _saveMergeMap() {
        // Intentionally does not touch dconf; see the note above.
    }

    /** The session-only maps as plain data, kept across the lock screen. */
    exportState() {
        return { arc: { merge: [...this._mergeMap], order: [...this._orderMap] } };
    }

    _loadOrderMap() {
        this._orderMap = new Map();
    }

    _saveOrderMap() {
        // Intentionally does not touch dconf; see the note above.
    }

    _mergeApps(sourceAppId, targetAppId) {
        const targetKey = this._mergeMap.get(targetAppId) ?? targetAppId;
        // Seed with the target's app id, never its group key: a key is a join of
        // ids, so folding one back in as an id doubles the key on every merge.
        const members = new Set([targetAppId, sourceAppId]);
        this._mergeMap.forEach((gKey, aId) => { if (gKey === targetKey) members.add(aId); });
        const newKey = [...members].sort().join('|');
        members.forEach(aId => this._mergeMap.set(aId, newKey));
        this._saveMergeMap();
    }

    _unmergeApp(appId) {
        this._mergeMap.delete(appId);
        const counts = new Map();
        this._mergeMap.forEach(gKey => counts.set(gKey, (counts.get(gKey) ?? 0) + 1));
        const toDelete = [];
        this._mergeMap.forEach((gKey, aId) => { if ((counts.get(gKey) ?? 0) <= 1) toDelete.push(aId); });
        toDelete.forEach(aId => this._mergeMap.delete(aId));
        this._saveMergeMap();
    }

    _buildGroups() {
        const workspace = global.workspace_manager.get_active_workspace();
        const tracker   = Shell.WindowTracker.get_default();
        const byWin     = new Map();

        // One card per window by default — grouping is purely manual (drag-to-merge).
        workspace.list_windows().forEach(win => {
            if (!_isNormal(win)) return;
            const app = tracker.get_window_app(win);
            if (!app) return;
            const key = this._windowKey(win);
            if (!byWin.has(key)) byWin.set(key, { app, appId: app.get_id(), windows: [] });
            byWin.get(key).windows.push(win);
        });

        const byGroup = new Map();
        byWin.forEach(({ app, appId, windows }, winKey) => {
            const groupKey = this._mergeMap.get(winKey) ?? winKey;
            if (!byGroup.has(groupKey))
                byGroup.set(groupKey, { appIds: [], apps: [], windows: [], windowKeys: [], key: groupKey });
            const g = byGroup.get(groupKey);
            g.appIds.push(appId);
            g.apps.push(app);
            g.windows.push(...windows);
            g.windowKeys.push(winKey);
        });

        this._groups = [...byGroup.values()].map(g => {
            g.appIds.sort();
            g.app = g.apps[0];
            return g;
        });

        const liveAppIds = new Set([...byWin.values()].map(v => v.appId));
        this._groupStates.forEach((_, id) => { if (!liveAppIds.has(id)) this._groupStates.delete(id); });

        this._groups.sort((a, b) => {
            const oa = this._orderMap.has(a.key) ? this._orderMap.get(a.key) : Number.MAX_SAFE_INTEGER;
            const ob = this._orderMap.has(b.key) ? this._orderMap.get(b.key) : Number.MAX_SAFE_INTEGER;
            return oa - ob;
        });

        this._offset = Math.max(0, Math.min(this._offset, this._groups.length - 1));

        const focused = global.display.get_focus_window();
        if (focused) {
            this._groups.forEach(g => {
                const fi = g.windows.indexOf(focused);
                if (fi > 0) {
                    g.windows.splice(fi, 1);
                    g.windows.unshift(focused);
                    const fApp = Shell.WindowTracker.get_default().get_window_app(focused);
                    if (fApp) g.app = fApp;
                }
            });
        }

        // Hide the card/group containing the focused window (arc-hide-active).
        const activeKey = this._activeKey ?? (focused ? this._windowKey(focused) : null);
        if (this._settings.get_boolean('arc-hide-active') && activeKey) {
            this._groups = this._groups.filter(g => !g.windowKeys.includes(activeKey));
            this._offset = Math.max(0, Math.min(this._offset, this._groups.length - 1));
        }
    }

    /** Stable per-window identity for the manual grouping map. */
    _windowKey(win) {
        return `w${win.get_stable_sequence()}`;
    }

    _loadConfig() {
        const s   = this._settings;
        const pct = s.get_int('arc-card-scale') / 100;

        this._gW        = Math.round(ARC_BASE_GRID_W * pct * this._scaleFactor);
        this._gH        = Math.round(ARC_BASE_GRID_H * pct * this._scaleFactor);
        this._iS        = Math.round(ARC_BASE_ICON_SIZE * pct * this._scaleFactor);
        this._panelSize = Math.ceil(this._gW * 1.12 + ARC_PAD_H * this._scaleFactor * 2);
        this._cxOffset  = ARC_PAD_H * this._scaleFactor + this._gW / 2;
        this._angleStep = s.get_int('arc-angle-step');
        this._hideDelay = s.get_int('auto-hide-delay');
        this._fanDelay  = s.get_int('arc-hover-fan-delay');
        this._scrollStep = this._mapSpeed(s.get_int('arc-scroll-speed'));
        this._pos       = s.get_string('arc-panel-position');
        this._persistEnabled = s.get_boolean('arc-persistent-mode');
        this._geo       = this._computeGeo();
    }

    _mapSpeed(val) {
        return 0.01 + (val - 1) * (0.15 - 0.01) / 19;
    }

    get _EDGE_W() { return this._settings.get_int('edge-trigger-width') * this._scaleFactor; }
    /** Pointer dwell before an edge reveal. A duration, so it is NOT scaled. */
    get _EDGE_DELAY_MS() { return this._settings.get_int('edge-trigger-delay'); }
    /** Honour the desktop "Reduce Animation" toggle — durations collapse to 0. */
    get _REDUCED_MOTION() { return St.Settings.get().enable_animations === false; }
    _animMs(ms) { return this._REDUCED_MOTION ? 0 : ms; }

    _computeGeo() {
        const mon = this._monitor;
        const PS  = this._panelSize;
        const CX  = this._cxOffset;
        const sf  = this._scaleFactor;

        // _getMon() returns a fresh object literal, so indexOf() on
        // layoutManager.monitors never matched and this silently fell back to
        // monitor 0. The index it already carries is the whole point.
        const wa = Main.layoutManager.getWorkAreaForMonitor(mon.index ?? 0);

        const R_side   = Math.max(Math.round(ARC_MIN_RADIUS * sf), Math.round(wa.height * ARC_RADIUS_RATIO));
        const R_bottom = Math.max(Math.round(ARC_MIN_RADIUS * sf), Math.round(wa.width  * ARC_RADIUS_RATIO));

        const waCY = wa.y - mon.y + wa.height / 2;
        const waCX = wa.x - mon.x + wa.width  / 2;
        const latY = wa.y - mon.y;
        const latH = wa.height;

        switch (this._pos) {
            case 'right':
                return {
                    panelX: mon.x + mon.width,       panelY: mon.y + latY,
                    panelW: PS,                       panelH: latH,
                    visX:   mon.x + mon.width - PS,   visY:   mon.y + latY,
                    hidX:   mon.x + mon.width,        hidY:   mon.y + latY,
                    edgeX:  mon.x + mon.width - this._EDGE_W,
                    edgeY:  wa.y,
                    edgeW:  this._EDGE_W, edgeH: wa.height,
                    arcCX:  PS - CX + R_side,
                    arcCY:  waCY - latY,
                    centerAngle: 180,
                    arcR: R_side,
                };
            case 'bottom':
                return {
                    panelX: mon.x,      panelY: mon.y + mon.height,
                    panelW: mon.width,  panelH: PS,
                    visX:   mon.x,      visY:   mon.y + mon.height - PS,
                    hidX:   mon.x,      hidY:   mon.y + mon.height,
                    edgeX:  wa.x,
                    edgeY:  mon.y + mon.height - this._EDGE_W,
                    edgeW:  wa.width, edgeH: this._EDGE_W,
                    arcCX:  waCX,
                    arcCY:  PS - CX + R_bottom,
                    centerAngle: -90,
                    arcR: R_bottom,
                };
            default: // left
                return {
                    panelX: mon.x - PS, panelY: mon.y + latY,
                    panelW: PS,         panelH: latH,
                    visX:   mon.x,      visY:   mon.y + latY,
                    hidX:   mon.x - PS, hidY:   mon.y + latY,
                    edgeX:  mon.x,
                    edgeY:  wa.y,
                    edgeW:  this._EDGE_W, edgeH: wa.height,
                    arcCX:  CX - R_side,
                    arcCY:  waCY - latY,
                    centerAngle: 0,
                    arcR: R_side,
                };
        }
    }

    _buildGrid(group, gridW, gridH, scale) {
        const windows = group.windows.slice(0, 4);
        const r = Math.round(10 * scale);

        const grid = new St.Widget({
            reactive: false,
            width: gridW, height: gridH,
            clip_to_allocation: false,
            style: `border-radius: ${Math.round(14 * scale)}px;`,
        });
        grid._cards = [];
        grid._fanned = false;
        grid._fanTimer = null;
        grid._closeTimer = null;
        this._cardSig(grid, 'destroy', () => this._killGridTimers(grid));
        grid._gridW = gridW;
        grid._gridH = gridH;
        grid._scale = scale;

        windows.forEach((win, idx) => {
            const actor = win.get_compositor_private();
            const fr    = win.get_frame_rect();
            const winW  = fr.width  || gridW;
            const winH  = fr.height || gridH;
            const s     = Math.min(gridW / winW, gridH / winH);
            const cW    = Math.round(winW * s);
            const cH    = Math.round(winH * s);

            const card = new St.Widget({
                reactive: true, width: cW, height: cH,
                clip_to_allocation: true,
                style: `border-radius: ${r}px;`,
            });
            card.set_pivot_point(0.5, 0.5);

            if (actor)
                card.add_child(new Clutter.Clone({ source: actor, width: cW, height: cH }));
            else
                card.add_child(new St.Widget({ style: `background-color:#2a2a2a; border-radius:${r}px;`, width: cW, height: cH }));

            const dim = new St.Widget({
                reactive: false, width: cW, height: cH,
                style: 'background-color: rgba(0,0,0,0.45); border-radius: inherit;',
                opacity: 0,
            });

            this._cardSig(card, 'button-press-event', (_a, ev) => this._onCardPressWindow(group, win, ev));

            this._cardSig(card, 'button-release-event', (_a, ev) => {
                if (this._drag?.moved) return Clutter.EVENT_STOP;
                if (ev.get_button() === 2) {
                    win.delete(global.get_current_time());
                    this._scheduleRefresh();
                    return Clutter.EVENT_STOP;
                }
                if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                if (!this._drag) return Clutter.EVENT_STOP;   // the drag poll already resolved this press
                this._cancelDrag();
                if (idx > 0) { group.windows.splice(idx, 1); group.windows.unshift(win); }
                // A click always brings the group forward; fanning is what
                // HOVER is for. Fanning on first click meant clicking a group
                // only rearranged the sidebar instead of switching to it.
                this._activateGroup(group, win);
                return Clutter.EVENT_STOP;
            });

            grid._cards.push({ card, dim, win, cW, cH });
        });

        [...grid._cards].reverse().forEach(({ card, dim }) => {
            grid.add_child(card);
            grid.add_child(dim);
        });

        this._positionStack(grid, false);
        return grid;
    }

    _positionStack(grid, animate = true) {
        const scale = grid._scale;
        const OFFSETS = [
            { dx: 0,                      dy: 0,                      rot:  0.0 },
            { dx: Math.round(10 * scale), dy: Math.round( 7 * scale), rot:  3.8 },
            { dx: Math.round(19 * scale), dy: Math.round(13 * scale), rot: -2.6 },
            { dx: Math.round(27 * scale), dy: Math.round(18 * scale), rot:  2.0 },
        ];
        grid._cards.forEach(({ card, dim, icon, iconBaseX, iconBaseY }, i) => {
            const off = OFFSETS[i] ?? OFFSETS[OFFSETS.length - 1];
            const delay = this._REDUCED_MOTION ? 0 : i * 30;
            if (animate) {
                card.ease({
                    x: off.dx, y: off.dy, rotation_angle_z: off.rot, opacity: 255,
                    duration: this._animMs(240),
                    delay,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } else {
                card.set_position(off.dx, off.dy);
                card.opacity = 255;
            }
            dim.set_position(off.dx, off.dy);
            if (icon && iconBaseX !== undefined) {
                if (animate) icon.ease({ x: iconBaseX, y: iconBaseY, duration: this._animMs(240), delay, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
                else icon.set_position(iconBaseX, iconBaseY);
            }
        });
        grid._fanned = false;
    }

    _positionFan(grid) {
        const count = grid._cards.length;
        if (count <= 1) return { shift: 0, isBottom: this._pos === 'bottom' };
        const isBottom = this._pos === 'bottom';
        const step = isBottom ? Math.round(grid._gridW * 0.90) : Math.round(grid._gridH * 0.88);

        const padH = grid._padH ?? 0;
        const sz   = grid._iconSz ?? 0;
        const ovf  = grid._iconOvf ?? 0;

        grid._cards.forEach(({ card, dim, icon, cW, cH }, i) => {
            const dx = isBottom ? i * step : 0;
            const dy = isBottom ? 0 : i * step;
            const delay = this._REDUCED_MOTION ? 0 : i * 35;
            const dur = this._animMs(300);
            card.ease({
                x: dx, y: dy, rotation_angle_z: 0, opacity: 255,
                duration: dur, delay, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            dim.set_position(dx, dy);
            if (icon && sz) {
                let ix, iy;
                if (isBottom) { ix = padH + dx - ovf; iy = dy - ovf; }
                else if (this._pos === 'right') { ix = padH + dx + cW - sz + ovf; iy = dy + cH - sz + ovf; }
                else { ix = padH + dx - ovf; iy = dy + cH - sz + ovf; }
                icon.ease({ x: ix, y: iy, duration: dur, delay, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
            }
        });
        grid._fanned = true;
        return { shift: (count - 1) * step * (grid._viewScale ?? 1), isBottom };
    }

    _buildIconRow(container, group, gridW, iconSize, iconOvl, padH, scale, grid) {
        const tracker = Shell.WindowTracker.get_default();
        const sz  = Math.round(iconSize * 0.92);
        const ovf = Math.round(sz * 0.28);
        const dX  = Math.round(sz * 0.72);
        const dY  = Math.round(sz * 0.14);

        grid._padH = padH;
        grid._iconSz = sz;
        grid._iconOvf = ovf;

        grid._cards.forEach(({ win, cW, cH }, i) => {
            const app = tracker.get_window_app(win);
            if (!app) return;

            // Anchor to the card's own fitted size (cW/cH), not the nominal box —
            // a letterboxed card is smaller, so anchoring to the box's far edge stranded the badge in blank space.
            let bx, by;
            if (this._pos === 'right') { bx = padH + cW - sz + ovf - i * dX; by = cH - sz + ovf - i * dY; }
            else if (this._pos === 'bottom') { bx = padH - ovf + i * dX; by = -ovf + i * dY; }
            else { bx = padH - ovf + i * dX; by = cH - sz + ovf - i * dY; }

            const icon = new St.Widget({ width: sz, height: sz, reactive: true });
            icon.add_child(app.create_icon_texture(sz));
            icon.set_position(bx, by);
            container.add_child(icon);

            this._cardSig(icon, 'button-press-event', (_a, ev) => this._onCardPressWindow(group, win, ev));

            this._cardSig(icon, 'button-release-event', (_a, ev) => {
                if (this._drag?.moved) return Clutter.EVENT_STOP;
                if (ev.get_button() === 2) {
                    win.delete(global.get_current_time());
                    this._scheduleRefresh();
                    return Clutter.EVENT_STOP;
                }
                if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                if (!this._drag) return Clutter.EVENT_STOP;   // the drag poll already resolved this press
                this._cancelDrag();
                if (i > 0) { group.windows.splice(i, 1); group.windows.unshift(win); }
                this._activateGroup(group, win);
                return Clutter.EVENT_STOP;
            });

            grid._cards[i].icon = icon;
            grid._cards[i].iconBaseX = bx;
            grid._cards[i].iconBaseY = by;
        });
    }

    _buildUI() {
        const geo = this._geo;

        // Not clipped: cards extend past this nominal box as they curve away
        // from the front — clipping would hide cards the angle cull already chose to show.
        this._panel = new St.Widget({
            reactive: true, clip_to_allocation: false,
            width: geo.panelW, height: geo.panelH,
        });
        this._panel.set_position(geo.panelX, geo.panelY);
        // Fullscreen is handled in _syncPanel(): a tracked actor gets shown again
        // by layoutManager, which would undo hiding it while parked.
        Main.layoutManager.addChrome(this._panel, { trackFullscreen: false });

        this._edge = new St.Widget({ reactive: true, width: geo.edgeW, height: geo.edgeH });
        this._edge.set_position(geo.edgeX, geo.edgeY);
        Main.layoutManager.addChrome(this._edge, { trackFullscreen: false });

        // Same dwell as StageSidebar — see the enter-event there and issue #2.
        this._sig(this._edge, 'enter-event', () => {
            if (this._isVisible || this._fullscreen()) return;
            const delay = this._EDGE_DELAY_MS;
            if (delay <= 0) {
                this._showPanel();
                return;
            }
            this._killEdgeTimer();
            this._edgeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._untrackTimer(this._edgeTimer); this._edgeTimer = null;
                if (!this._isVisible && !this._fullscreen()) this._showPanel();
                return GLib.SOURCE_REMOVE;
            });
            this._timers.push(this._edgeTimer);
        });
        this._sig(this._edge, 'leave-event', () => this._killEdgeTimer());
        this._sig(this._panel, 'enter-event', () => { if (!this._drag) this._cancelHide(); });
        this._sig(this._panel, 'leave-event', () => {
            if (this._isVisible && !this._drag) this._startHide();
            // Collapse expanded groups once the pointer leaves (respecting hold).
            this._scheduleFanCollapse();
        });
        this._sig(this._panel, 'scroll-event', (_a, event) => { this._handleScroll(event); return Clutter.EVENT_STOP; });
        this._syncEdge();
        this._syncPanel();
    }

    /** Drawn only while out. Parked at hidX the panel can sit on a neighbouring
     *  monitor, where its cards stayed painted, or invisible but still clickable. */
    _syncPanel() {
        if (this._panel) this._panel.visible = this._isVisible && !this._fullscreen();
    }

    /** Edge strip only while it can do something: Arc hidden, no fullscreen.
     *  Left up while Arc was open, it sat on top of the carousel and took the
     *  pointer at the screen edge, which read as leaving and started a hide. */
    _syncEdge() {
        if (this._edge) this._edge.visible = !this._isVisible && !this._fullscreen();
    }

    _fullscreen() {
        return global.display.get_monitor_in_fullscreen(this._monitor?.index ?? 0);
    }

    _destroyUI() {
        this._cancelHide();
        this._containers.forEach(c => c.destroy());
        this._containers = [];
        if (this._edge)  { this._edge.destroy();  this._edge = null; }
        if (this._panel) { this._panel.destroy(); this._panel = null; }
    }

    _rebuild() {
        const wasVisible = this._isVisible;
        this._isVisible = false;
        this._monitor = this._pickMonitor();
        this._destroyUI();
        this._loadConfig();
        this._buildUI();
        if (wasVisible) this._showPanel();
        else this._scheduleRefresh();
    }

    _scheduleRefresh() {
        this._killRefreshTimer();
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._untrackTimer(this._refreshTimer); this._refreshTimer = null;
            this._buildGroups();
            // Hidden: nothing to see, and _showPanel() redraws on the way in.
            if (this._isVisible) this._redraw();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._refreshTimer);
    }

    _trackFocus() {
        const focused = global.display.get_focus_window();
        // Keep the last known active window even when focus briefly becomes null
        // (e.g. while hovering the sidebar or dragging), so hide-active stays.
        if (focused && _isNormal(focused))
            this._activeKey = this._windowKey(focused);
        if (!focused) return;
        const app = Shell.WindowTracker.get_default().get_window_app(focused);
        if (!app) return;
        const id = app.get_id();
        if (!this._groupStates.has(id)) this._groupStates.set(id, { savedLayout: new Map(), lastFocused: focused });
        else this._groupStates.get(id).lastFocused = focused;
    }

    /** Handle a newly created window: optional keep-visible behavior and optional
     *  merge-into-active-group when the window comes from the overview. */
    _onWindowCreated(win) {
        if (!win || !_isNormal(win)) return;
        // The transient/type of a dialog is often finalized slightly AFTER
        // window-created, so capture the previous app now and re-check later.
        const prevFocused = global.display.get_focus_window();
        const prevApp = prevFocused ? Shell.WindowTracker.get_default().get_window_app(prevFocused) : null;
        this._pendingNewWindows.push({ win, prevApp });
        this._killNewWindowTimer();
        this._newWindowTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._untrackTimer(this._newWindowTimer); this._newWindowTimer = null;
            const batch = this._pendingNewWindows.splice(0);
            const fresh = new Set(batch.map(p => p.win));
            for (const pending of batch)
                this._handleNewWindow(pending.win, pending.prevApp, fresh);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._newWindowTimer);
    }

    /** `fresh`: every window of this batch, none of which may minimize another. */
    _handleNewWindow(win, prevApp, fresh = new Set([win])) {
        if (!win || !_isNormal(win)) return;
        // Skip transient windows (dialogs like the file chooser).
        if (win.get_transient_for()) return;
        // Skip windows belonging to the previously-focused app (dialogs or
        // same-app windows, not a brand-new application card).
        const tracker = Shell.WindowTracker.get_default();
        const newApp = tracker.get_window_app(win);
        if (newApp && prevApp && newApp.get_id() === prevApp.get_id()) return;

        // "Keep Windows Visible" off → minimize every other window so only the
        // newest one is shown instead of stacking them.
        if (!this._settings.get_boolean('arc-keep-visible')) {
            const ws = global.workspace_manager.get_active_workspace();
            if (ws) {
                ws.list_windows().forEach(w => {
                    if (_isNormal(w) && !fresh.has(w) && !w.minimized)
                        w.minimize();
                });
            }
        }

        // "Merge Apps Opened From Overview" → join the new window to the active
        // group (if any) instead of giving it its own card.
        if (this._overviewActive && this._settings.get_boolean('arc-overview-merge')) {
            const newKey = this._windowKey(win);
            const activeKey = this._activeKey;
            if (activeKey && activeKey !== newKey) {
                this._mergeApps(newKey, activeKey);
                this._scheduleRefresh();
                this._syncActiveGroup();
            }
        }
    }

    _onOverviewShowing() {
        this._overviewActive = true;
        if (!this._settings.get_boolean('arc-show-in-overview'))
            this._hidePanel();
    }

    _onOverviewHidden() {
        this._overviewActive = false;
        if (this._persistEnabled)
            this._checkPersistence();
        // After leaving the overview, show only the focused window's group
        // (minimize the rest) instead of revealing every window at once.
        this._killOverviewSyncTimer();
        this._overviewSyncTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._untrackTimer(this._overviewSyncTimer); this._overviewSyncTimer = null;
            this._syncActiveGroup();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._overviewSyncTimer);
    }

    _redraw() {
        if (!this._panel) return;

        this._killCardTimers();
        this._disconnectCardSigs();
        this._containers.forEach(c => c.destroy());
        this._containers = [];
        this._containerByKey = new Map();
        if (this._groups.length === 0) return;

        this._groups.forEach((group, idx) => {
            const layout = this._layoutForGroup(idx);
            if (layout) this._addContainer(group, idx, layout);
        });

        // Re-fan the group that was spread before a refresh (e.g. while cycling
        // its windows), so it doesn't collapse on every focus change.
        if (this._fannedGroupKey) {
            const fanned = this._containerByKey.get(this._fannedGroupKey);
            if (fanned) this._fanGroup(fanned);
            else this._fannedGroupKey = null;
        }
    }

    /** Build one card. _containers and paint order both follow the group order,
     *  so a card built later (scrolled into range) lands where _redraw() puts it. */
    _addContainer(group, idx, layout) {
        const { P, ovl, FW, FH } = this._fullSize();
        const container = new St.Widget({
            reactive: true, track_hover: true,
            width: FW, height: FH,
            opacity: layout.opacity,
        });
        container.set_pivot_point(0.5, 0.5);
        container._groupKey = group.key;
        container._groupRef = group;
        container._idx = idx;
        this._applyLayout(container, layout);

        const grid = this._buildGrid(group, this._gW, this._gH, 1);
        grid.set_position(P, 0);
        grid._viewScale = layout.scale;
        container.add_child(grid);
        container._grid = grid;

        this._buildIconRow(container, group, this._gW, this._iS, ovl, P, 1, grid);

        this._cardSig(container, 'notify::hover', () => this._onCardHover(container));
        this._cardSig(container, 'button-press-event', (_a, event) => this._onCardPress(container, group, event));
        this._cardSig(container, 'button-release-event', (_a, event) => this._onCardRelease(container, group, idx, event));

        const next = this._containers.find(c => c._idx > idx);
        if (next) {
            this._containers.splice(this._containers.indexOf(next), 0, container);
            this._panel.insert_child_below(container, next);
        } else {
            this._containers.push(container);
            this._panel.add_child(container);
        }
        this._containerByKey.set(group.key, container);
    }

    /** Card dimensions at scale 1 (full front size). Cards shrink by scaling the
     *  container instead of resizing it, so scrolling can reuse them. */
    _fullSize() {
        const P   = Math.round(ARC_PAD_H * this._scaleFactor);
        const ovl = Math.round(ARC_ICON_OVL * this._scaleFactor);
        return { P, ovl, FW: this._gW + P * 2, FH: this._gH + this._iS - ovl };
    }

    /** Per-card layout at the current offset, or null when off the visible arc. */
    _layoutForGroup(idx) {
        const geo = this._geo;
        const relIdx = idx - this._offset;
        if (Math.abs(relIdx * this._angleStep) > ARC_MAX_ANGLE + this._angleStep) return null;

        const angleDeg = geo.centerAngle + relIdx * this._angleStep;
        const angleRad = angleDeg * Math.PI / 180;
        const itemCX = geo.arcCX + geo.arcR * Math.cos(angleRad);
        const itemCY = geo.arcCY + geo.arcR * Math.sin(angleRad);

        const dist  = Math.abs(relIdx);
        const scale = Math.pow(0.78, dist);

        const fadeAngle = Math.abs(relIdx * this._angleStep);
        let opacity = 255;
        if (fadeAngle > ARC_FADE_START)
            opacity = Math.max(0, Math.round(255 * (1 - (fadeAngle - ARC_FADE_START) / (ARC_MAX_ANGLE - ARC_FADE_START))));

        return { itemCX, itemCY, scale, opacity };
    }

    /** Position + scale + fade an existing card without touching its children. */
    _applyLayout(container, layout) {
        const { FW, FH } = this._fullSize();
        const hover = container._hoverFactor ?? 1;
        const x = layout.itemCX - FW / 2;
        const y = layout.itemCY - FH / 2;
        container.set_position(x, y);
        container._baseX = x;
        container._baseY = y;
        container.set_scale(layout.scale * hover, layout.scale * hover);
        container._arcScale = layout.scale;
        container._fadeOpacity = layout.opacity;
        container.opacity = layout.opacity;
        if (container._grid) container._grid._viewScale = layout.scale;
    }

    /** Cheap per-frame scroll update: move/scale existing cards in place instead
     *  of rebuilding them (which caused the jitter during momentum scrolling). */
    _updatePositions() {
        if (!this._panel) return;
        this._groups.forEach((group, idx) => {
            const container = this._containerByKey.get(group.key);
            const layout = this._layoutForGroup(idx);
            // Scrolled into range since the last redraw: build it, or the arc runs empty.
            if (!container) {
                if (layout) this._addContainer(group, idx, layout);
                return;
            }
            if (!layout) {
                container.hide();
                return;
            }
            container.show();
            this._applyLayout(container, layout);
        });
    }

    _onCardHover(container) {
        if (container.hover) {
            this._hoveredContainer = container;
            // Collapse any other group that is still fanned out, so only the
            // newly-hovered group stays spread.
            this._containers.forEach(c => {
                if (c !== container) this._collapseGroup(c);
            });
            // Gentle inward lift for the hovered card; siblings settle back a
            // touch so the front card reads clearly.
            const liftX = this._pos === 'right' ? -12 : (this._pos === 'bottom' ? 0 : 12);
            const liftY = this._pos === 'bottom' ? -12 : 0;
            this._containers.forEach(c => {
                const isThis = c === container;
                const arc = c._arcScale ?? 1;
                const factor = isThis ? 1.1 : 0.94;
                c._hoverFactor = factor;
                c.ease({
                    scale_x: arc * factor, scale_y: arc * factor,
                    translation_x: isThis ? liftX : 0,
                    translation_y: isThis ? liftY : 0,
                    opacity: isThis ? 255 : (c._fadeOpacity ?? 255),
                    duration: this._animMs(200), mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            });
            this._panel.set_child_above_sibling(container, null);
            const g = container._grid;
            // Only auto-fan after the configured hover delay (0 = never).
            if (g && !g._fanned && !g._fanTimer && this._fanDelay > 0) {
                g._fanTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._fanDelay, () => {
                    this._untrackTimer(g._fanTimer); g._fanTimer = null;
                    if (container.hover && !this._drag && !g._fanned) {
                        this._fanGroup(container);
                    }
                    return GLib.SOURCE_REMOVE;
                });
                this._timers.push(g._fanTimer);
            }
        } else {
            if (this._hoveredContainer === container) this._hoveredContainer = null;
            const g = container._grid;
            this._killGridTimers(g);
            // Reset the hover lift/scale/dim on every card.
            this._containers.forEach(c => {
                const arc = c._arcScale ?? 1;
                c._hoverFactor = 1;
                c.ease({
                    scale_x: arc, scale_y: arc,
                    translation_x: 0, translation_y: 0,
                    opacity: c._fadeOpacity ?? 255,
                    duration: this._animMs(200), mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            });
            if (g?._fanned) {
                const ms = this._fanHoldMs();
                if (ms <= 0) {
                    this._collapseGroup(container);
                } else {
                    if (g._closeTimer) { GLib.source_remove(g._closeTimer); this._untrackTimer(g._closeTimer); g._closeTimer = null; }
                    g._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                        this._untrackTimer(g._closeTimer); g._closeTimer = null;
                        if (!container.hover) this._collapseGroup(container);
                        return GLib.SOURCE_REMOVE;
                    });
                    this._timers.push(g._closeTimer);
                }
            }
        }
    }

    /** Fan a group out and remember it so it stays fanned across refreshes. */
    _fanGroup(container) {
        const g = container?._grid;
        if (!g || g._fanned) return;
        const { shift, isBottom } = this._positionFan(g);
        this._pushSiblings(container, shift, isBottom);
        this._fannedGroupKey = container._groupKey;
    }

    /** Immediately collapse a group that is fanned out (no close-delay). */
    _collapseGroup(container) {
        const g = container._grid;
        if (!g || !g._fanned) return;
        if (container._groupKey === this._fannedGroupKey) this._fannedGroupKey = null;
        this._killGridTimers(g);
        this._positionStack(g);
        this._pushSiblings(container, 0, this._pos === 'bottom');
    }

    /** Collapse every fanned group (e.g. when the pointer leaves the sidebar). */
    _collapseFanned() {
        this._containers.forEach(c => {
            if (c._grid?._fanned) this._collapseGroup(c);
        });
    }

    /** Collapse delay based on the hold toggle (0 = collapse immediately). */
    _fanHoldMs() {
        if (!this._settings.get_boolean('arc-fan-hold')) return 0;
        return this._settings.get_int('arc-fan-hold-delay');
    }

    _killFanCollapseTimer() {
        if (this._fanCollapseTimer) {
            GLib.source_remove(this._fanCollapseTimer);
            this._untrackTimer(this._fanCollapseTimer);
            this._fanCollapseTimer = null;
        }
    }

    /** Collapse fanned groups now, or after the hold delay. */
    _scheduleFanCollapse() {
        this._killFanCollapseTimer();
        const ms = this._fanHoldMs();
        if (ms <= 0) {
            this._collapseFanned();
            return;
        }
        this._fanCollapseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._untrackTimer(this._fanCollapseTimer); this._fanCollapseTimer = null;
            this._collapseFanned();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._fanCollapseTimer);
    }

    /** Shoves arc siblings out of a fanned card's way (else the fan just paints
     *  over the next group). Only siblings ahead of `container` move, matching _positionFan()'s direction. */
    _pushSiblings(container, shift, isBottom) {
        const idx = this._containers.indexOf(container);
        this._containers.forEach((c, i) => {
            if (c === container || i <= idx) return;
            c.ease({
                x: c._baseX + (isBottom ? shift : 0),
                y: c._baseY + (isBottom ? 0 : shift),
                duration: this._animMs(240), mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
    }

    _activateGroup(group, focusWin = null) {
        const tracker = Shell.WindowTracker.get_default();
        const focused = global.display.get_focus_window();
        if (focused) {
            const app = tracker.get_window_app(focused);
            if (app) {
                const fid = app.get_id();
                if (!this._groupStates.has(fid)) this._groupStates.set(fid, { savedLayout: new Map(), lastFocused: focused });
                const state = this._groupStates.get(fid);
                state.savedLayout.clear();
                global.workspace_manager.get_active_workspace().list_windows().forEach(win => {
                    const wa = tracker.get_window_app(win);
                    if (wa && wa.get_id() === fid) state.savedLayout.set(win, win.get_frame_rect());
                });
            }
        }

        global.workspace_manager.get_active_workspace().list_windows().forEach(win => {
            if (_isNormal(win) && !group.windows.includes(win) && !win.minimized) win.minimize();
        });

        group.windows.forEach(win => {
            if (win.minimized) win.unminimize();
            const app = tracker.get_window_app(win);
            if (app) {
                const state = this._groupStates.get(app.get_id());
                if (state?.savedLayout.has(win)) {
                    const rect = state.savedLayout.get(win);
                    win.move_resize_frame?.(true, rect.x, rect.y, rect.width, rect.height);
                }
            }
        });

        // An app's last-focused window can be on another card, or closed.
        let target = focusWin ?? null;
        group.appIds.forEach(id => {
            const last = this._groupStates.get(id)?.lastFocused;
            if (!target && group.windows.includes(last)) target = last;
        });
        (target ?? group.windows[0])?.activate(global.get_current_time());

        this._hidePanel();
    }

    _onCardPress(container, group, event) {
        if (event.get_button() === 3 && group.windowKeys.length > 1) {
            this._ungroupGroup(group);
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() === 1) {
            this._cancelDrag();
            const [px, py] = global.get_pointer();
            this._drag = { group, card: container, startX: px, startY: py, moved: false };
            this._sig(global.stage, 'motion-event', (_a, ev) => this._onDragMotion(ev));
            this._armDragPollTimer();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** Per-window drag: grabbing one thumbnail inside a grouped card drags just
     *  that window, so it can be pulled out to ungroup or dropped onto another
     *  card — instead of always moving the whole group. */
    _onCardPressWindow(group, win, event) {
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
        this._cancelDrag();
        const [px, py] = global.get_pointer();
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        const winKey = this._windowKey(win);
        this._drag = {
            group: {
                windows: [win],
                windowKeys: [winKey],
                appIds: app ? [app.get_id()] : [],
                apps: app ? [app] : [],
                app,
                key: winKey,
            },
            parentGroup: group,
            single: true,
            startX: px, startY: py,
            moved: false,
        };
        this._sig(global.stage, 'motion-event', (_a, ev) => this._onDragMotion(ev));
        this._armDragPollTimer();
        return Clutter.EVENT_STOP;
    }

    /** Safety net: resolves the drag from live pointer-button state, not just
     *  release-event — covers the origin card dying mid-drag, which kills Clutter's implicit grab before release fires. */
    _armDragPollTimer() {
        this._killDragPollTimer();
        this._dragPollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._drag) { this._untrackTimer(this._dragPollTimer); this._dragPollTimer = null; return GLib.SOURCE_REMOVE; }
            const [px, py, mask] = global.get_pointer();
            if (mask & Clutter.ModifierType.BUTTON1_MASK) return GLib.SOURCE_CONTINUE;

            this._untrackTimer(this._dragPollTimer);
            this._dragPollTimer = null;
            const drag = this._drag;
            this._cancelDrag();
            if (drag.moved) this._commitDrag(drag, px, py);
            else this._activateGroup(drag.parentGroup ?? drag.group, drag.single ? drag.group.windows[0] : null);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._dragPollTimer);
    }

    _onDragMotion(event) {
        if (!this._drag) return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        const dx = px - this._drag.startX;
        const dy = py - this._drag.startY;
        if (!this._drag.moved && Math.hypot(dx, dy) > ARC_DRAG_THRESHOLD * this._scaleFactor) {
            this._drag.moved = true;
            this._startDragGhost(this._drag.group);
        }
        if (this._drag.moved) this._updateDragGhost(px, py);
        return Clutter.EVENT_PROPAGATE;
    }

    _onCardRelease(_container, group, idx, event) {
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
        const drag = this._drag;
        if (!drag) return Clutter.EVENT_PROPAGATE;
        const [px, py] = global.get_pointer();
        this._cancelDrag();

        if (!drag.moved) {
            if (idx !== Math.round(this._offset)) this._scrollTo(idx, () => this._activateGroup(group));
            else this._activateGroup(group);
            return Clutter.EVENT_STOP;
        }

        this._commitDrag(drag, px, py);
        return Clutter.EVENT_STOP;
    }

    _commitDrag(drag, px, py) {
        const group = drag.group;
        const single = drag.single === true;
        const refGroup = single ? drag.parentGroup : group;
        const geo = this._geo;
        const inside = px >= geo.visX && px <= geo.visX + geo.panelW &&
                       py >= geo.visY && py <= geo.visY + geo.panelH;
        if (inside) {
            // Dropping a single dragged window onto another card groups it there;
            // anything else just reorders.
            const target = this._containerAt(px, py);
            if (single && target && target._groupRef !== refGroup)
                this._moveWindowIntoGroup(group.windowKeys[0], target._groupRef);
            else
                this._reorderGroup(refGroup, px, py);
        } else if (!this._mergeIntoActive(group)) {
            // No distinct active group to merge into → ungroup as fallback.
            if (single) {
                if (drag.parentGroup && drag.parentGroup.windowKeys.length > 1) {
                    this._unmergeApp(group.windowKeys[0]);
                    this._scheduleRefresh();
                    this._syncActiveGroup();
                }
            } else if (group.windowKeys.length > 1) {
                this._ungroupGroup(group);
            }
        }
    }

    /** Move a single window out of its current group and into `targetGroup`. */
    _moveWindowIntoGroup(winKey, targetGroup) {
        this._unmergeApp(winKey);          // detach from the window's old group
        const targetKey = targetGroup.windowKeys[0];
        if (targetKey && targetKey !== winKey) this._mergeApps(winKey, targetKey);
        this._scheduleRefresh();
        this._syncActiveGroup();
    }

    /** Card under a point (global coords), or null over blank space. Skips the
     *  drag ghost by only picking reactive actors. */
    _containerAt(px, py) {
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, px, py);
        while (actor) {
            if (actor._groupRef) return actor;
            actor = actor.get_parent();
        }
        return null;
    }

    /** Merge every app in `sourceGroup` into `targetGroup` (drag-to-group). */
    _mergeIntoGroup(sourceGroup, targetGroup) {
        const targetKey = targetGroup.windowKeys[0];
        if (!targetKey) return;
        for (const sk of sourceGroup.windowKeys) {
            if (sk === targetKey) continue;
            this._mergeApps(sk, targetKey);
        }
        this._scheduleRefresh();
    }

    /** Split a merged card back into one card per window. */
    _ungroupGroup(group) {
        group.windowKeys.forEach(k => this._unmergeApp(k));
        this._scheduleRefresh();
        this._syncActiveGroup();
    }

    _mergeIntoActive(sourceGroup) {
        const focused = global.display.get_focus_window();
        if (!focused || !_isNormal(focused)) return false;
        const targetKey = this._windowKey(focused);
        // Already the active group — nothing to merge into.
        if (sourceGroup.windowKeys.includes(targetKey)) return false;
        for (const sk of sourceGroup.windowKeys) this._mergeApps(sk, targetKey);
        this._scheduleRefresh();
        this._syncActiveGroup();
        return true;
    }

    /** Make the desktop match the active group: show its windows and minimize the
     *  rest, so grouping changes are visible immediately. */
    _syncActiveGroup() {
        const focused = global.display.get_focus_window();
        if (!focused || !_isNormal(focused)) return;
        const activeKey = this._windowKey(focused);
        const activeGroupKey = this._mergeMap.get(activeKey) ?? activeKey;
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        ws.list_windows().forEach(win => {
            if (!_isNormal(win)) return;
            const k = this._windowKey(win);
            const gk = this._mergeMap.get(k) ?? k;
            if (gk === activeGroupKey) {
                if (win.minimized) win.unminimize();
            } else if (!win.minimized) {
                win.minimize();
            }
        });
    }

    _reorderGroup(group, px, py) {
        if (this._groups.length < 2 || this._containers.length < 2) return;
        const sourceIdx = this._groups.indexOf(group);
        if (sourceIdx === -1) return;

        // Cards sit in panel coordinates, and only some groups have one: compare
        // in the panel's space and keep the index in group order.
        const [, lx, ly] = this._panel.transform_stage_point(px, py);
        let targetIdx = sourceIdx;
        let minDist = Infinity;
        this._groups.forEach((g, i) => {
            const c = this._containerByKey.get(g.key);
            if (!c?.visible) return;
            const cx = c.x + c.width / 2;
            const cy = c.y + c.height / 2;
            const dist = this._pos === 'bottom' ? Math.abs(lx - cx) : Math.abs(ly - cy);
            if (dist < minDist) { minDist = dist; targetIdx = i; }
        });
        if (targetIdx === sourceIdx) return;

        const ordered = [...this._groups];
        const [moved] = ordered.splice(sourceIdx, 1);
        ordered.splice(targetIdx, 0, moved);
        this._orderMap.clear();
        ordered.forEach((g, i) => this._orderMap.set(g.key, i));
        this._saveOrderMap();
        this._scheduleRefresh();
    }

    _startDragGhost(group) {
        const size = Math.round(ARC_GHOST_SIZE * this._scaleFactor);
        const ghost = new St.Widget({
            width: size, height: size, opacity: 230,
            style: 'background-color: rgba(30,30,30,0.88); border-radius: 18px; border: 2px solid rgba(255,255,255,0.28);',
        });
        ghost.set_pivot_point(0.5, 0.5);

        const win = group.windows[0];
        const actor = win?.get_compositor_private?.();
        if (group.windows.length === 1 && win && actor) {
            // Per-window drag: show a live thumbnail of that window.
            const fr = win.get_frame_rect();
            const a = (fr.width || 1) / (fr.height || 1);
            let w = size, h = size;
            if (a > 1) h = Math.max(1, Math.round(size / a));
            else w = Math.max(1, Math.round(size * a));
            const clone = new Clutter.Clone({ source: actor, width: w, height: h });
            clone.set_position((size - w) / 2, (size - h) / 2);
            ghost.add_child(clone);
        } else {
            const iconSize = Math.round(48 * this._scaleFactor);
            const icon = new St.Widget({ width: iconSize, height: iconSize });
            icon.add_child(group.app.create_icon_texture(iconSize));
            icon.set_position(size / 2 - iconSize / 2, size / 2 - iconSize / 2);
            ghost.add_child(icon);
        }

        Main.uiGroup.add_child(ghost);
        this._dragGhost = ghost;
    }

    _updateDragGhost(px, py) {
        if (!this._dragGhost) return;
        const size = Math.round(ARC_GHOST_SIZE * this._scaleFactor);
        this._dragGhost.set_position(px - size / 2, py - size / 2);
    }

    _killDragGhost() { if (this._dragGhost) { this._dragGhost.destroy(); this._dragGhost = null; } }

    _cancelDrag() {
        this._killDragPollTimer();
        this._killDragGhost();
        // Unconditional — disable() calls this, and an early return here would
        // read as selective disable (same fix as _cancelAppDrag).
        this._drag = null;
        global.stage.disconnectObject(this);
    }

    _handleScroll(event) {
        const dir = this._scrollDirection(event);
        if (dir === 0) return;

        const isBottom = this._pos === 'bottom';
        if (event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const delta = isBottom ? dx : dy;
            this._velocity += delta * this._scrollStep;
        } else {
            this._velocity += dir * this._scrollStep;
        }
        this._startPhysics();
    }

    /** -1 / 0 / +1 for the carousel scroll direction. */
    _scrollDirection(event) {
        const dir = event.get_scroll_direction();
        const isBottom = this._pos === 'bottom';
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const delta = isBottom ? dx : dy;
            if (delta > 0.01) return 1;
            if (delta < -0.01) return -1;
            return 0;
        }
        if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) return 1;
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) return -1;
        return 0;
    }

    _startPhysics() {
        this._killScrollTimer();
        // EGO-L-007: inlined, not via _killPhysicsTimer — shexli wants the
        // remove textually adjacent to this re-arm (see _scrollTo() below).
        if (this._physicsTimer) { GLib.source_remove(this._physicsTimer); this._untrackTimer(this._physicsTimer); this._physicsTimer = null; }
        this._physicsTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            this._offset += this._velocity;
            this._velocity *= ARC_SCROLL_FRICTION;
            const max = Math.max(0, this._groups.length - 1);
            if (this._offset < 0) { this._offset = 0; this._velocity = 0; }
            if (this._offset > max) { this._offset = max; this._velocity = 0; }
            this._updatePositions();
            if (Math.abs(this._velocity) < ARC_SCROLL_MIN_VEL) {
                this._velocity = 0;
                this._untrackTimer(this._physicsTimer); this._physicsTimer = null;
                this._snapToNearest();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.push(this._physicsTimer);
    }

    /** After momentum settles, ease onto the closest card so the carousel always
     *  rests cleanly aligned instead of parked between two cards. */
    _snapToNearest() {
        const target = Math.round(this._offset);
        if (Math.abs(target - this._offset) < 0.001) return;
        this._scrollTo(target, null);
    }

    _scrollTo(targetIdx, onComplete) {
        this._velocity = 0;
        targetIdx = Math.max(0, Math.min(targetIdx, this._groups.length - 1));
        const start = this._offset;
        const frames = Math.max(8, Math.round(Math.abs(targetIdx - start) * 12));
        let frame = 0;
        this._killPhysicsTimer();
        // EGO-L-007: inlined, not via _killScrollTimer — shexli wants the
        // remove textually adjacent to this re-arm.
        if (this._scrollTimer) { GLib.source_remove(this._scrollTimer); this._untrackTimer(this._scrollTimer); this._scrollTimer = null; }
        this._scrollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            frame++;
            this._offset = start + (targetIdx - start) * (1 - Math.pow(1 - frame / frames, 3));
            this._updatePositions();
            if (frame >= frames) {
                this._offset = targetIdx;
                this._untrackTimer(this._scrollTimer); this._scrollTimer = null;
                this._updatePositions();
                onComplete?.();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.push(this._scrollTimer);
    }

    _showPanel() {
        if (this._isVisible || !this._panel) return;
        this._isVisible = true;
        this._syncEdge();
        this._syncPanel();
        this._cancelHide();
        // Rebuilt now, not 50 ms in: refreshes skip the redraw while hidden, so
        // the cards on hand may be stale.
        this._killRefreshTimer();
        this._buildGroups();
        this._redraw();
        const geo = this._geo;
        this._panel.remove_all_transitions();
        this._panel.opacity = 0;
        this._panel.ease({
            x: geo.visX, y: geo.visY, opacity: 255,
            duration: this._animMs(220), mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _hidePanel() {
        if (!this._isVisible || !this._panel) return;
        this._isVisible = false;
        this._syncEdge();
        this._cancelHide();
        this._collapseFanned();
        const geo = this._geo;
        this._panel.remove_all_transitions();
        this._panel.ease({
            x: geo.hidX, y: geo.hidY, opacity: 0,
            duration: this._animMs(200), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._syncPanel(),
        });
    }

    _startHide(delay = this._hideDelay) {
        if (this._persistMode) return;
        this._cancelHide();
        this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hidePanel();
            this._untrackTimer(this._hideTimer); this._hideTimer = null;
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(this._hideTimer);
    }

    _cancelHide() { this._killHideTimer(); }

    _checkPersistence() {
        if (!this._persistEnabled) {
            if (this._persistMode) { this._persistMode = false; this._hidePanel(); }
            return;
        }
        // Keep the sidebar hidden during the overview when the toggle is off.
        if (this._overviewActive && !this._settings.get_boolean('arc-show-in-overview')) {
            if (this._isVisible) this._hidePanel();
            return;
        }
        const ws = global.workspace_manager.get_active_workspace();
        const geo = this._geo;
        const px1 = geo.visX, py1 = geo.visY, px2 = geo.visX + geo.panelW, py2 = geo.visY + geo.panelH;
        const clear = !ws.list_windows().some(win => {
            if (win.minimized || !_isNormal(win)) return false;
            const r = win.get_frame_rect();
            return r.x < px2 && r.x + r.width > px1 && r.y < py2 && r.y + r.height > py1;
        });
        if (clear && !this._persistMode) { this._persistMode = true; if (!this._isVisible) this._showPanel(); }
        else if (!clear && this._persistMode) { this._persistMode = false; this._hidePanel(); }
    }

    _addKeybindings() {
        this._boundKeys = [];
        ARC_KEYBINDINGS.forEach(key => {
            const binding = this._settings.get_strv(key)[0];
            if (!binding || binding === '') return;
            Main.wm.addKeybinding(
                key, this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                this._keybindingCallback(key),
            );
            this._boundKeys.push(key);
        });
    }

    _keybindingCallback(key) {
        switch (key) {
            case 'toggle-sidebar': return () => this._toggleVisible();
            case 'keybinding-show-desktop': return () => this._showDesktop();
            case 'keybinding-arc-next': return () => this._scrollTo(Math.round(this._offset) + 1);
            case 'keybinding-arc-prev': return () => this._scrollTo(Math.round(this._offset) - 1);
            case 'keybinding-arc-activate': return () => {
                const idx = Math.round(this._offset);
                if (this._groups[idx]) { if (!this._isVisible) this._showPanel(); this._activateGroup(this._groups[idx]); }
            };
            case 'keybinding-arc-close': return () => {
                const idx = Math.round(this._offset);
                const grp = this._groups[idx];
                if (grp?.windows[0]) {
                    grp.windows[0].delete(global.get_current_time());
                    this._scheduleRefresh();
                }
            };
        }
        return () => {};
    }

    _removeKeybindings() {
        this._boundKeys.forEach(key => Main.wm.removeKeybinding(key));
        this._boundKeys = [];
    }

    _toggleVisible() {
        if (this._isVisible) this._hidePanel();
        else this._showPanel();
    }

    /** macOS "Show Desktop": minimize every visible window so the wallpaper is
     *  revealed, leaving the arc carousel up with each app as a card. */
    _showDesktop() {
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        ws.list_windows().forEach(win => {
            if (_isNormal(win) && !win.minimized) win.minimize();
        });
        this._scheduleRefresh();
    }
}


// ─── Main ───────────────────────────────────────────────────────────────────

export default class StageManagerExtension extends Extension {
    enable() {
        this._sigSources = new Set();
        this._settings = this.getSettings();
        this._migrateMaximize();
        const saved = this._lockState ?? {};   // see disable()
        this._lockState = null;
        this._max = new MaximizeToWorkspace(this._settings, saved.max);
        this._max.enable();
        // Arc peeks once per login, not after every unlock: the shell disables
        // and re-enables extensions around the lock screen, and this instance
        // (unlike the sidebar) survives that.
        this._buildActiveSidebar(!this._peekedThisSession, saved.side);
        this._peekedThisSession = true;
        this._sig(this._settings, 'changed::sidebar-layout', () => this._swapSidebar());
    }

    /** Fold the two deprecated maximize switches into maximize-behavior once.
     *  Workspace wins when both were on — that was the old precedence. */
    _migrateMaximize() {
        if (this._settings.get_boolean('maximize-migrated')) return;
        if (this._settings.get_boolean('enable-maximize-to-workspace'))
            this._settings.set_string('maximize-behavior', 'workspace');
        else if (this._settings.get_boolean('maximize-to-new-group'))
            this._settings.set_string('maximize-behavior', 'stage');
        this._settings.set_boolean('maximize-migrated', true);
    }

    _sig(obj, signal, cb) {
        obj.connectObject(signal, cb, this);
        this._sigSources.add(obj);
    }

    _buildActiveSidebar(peek = false, saved = null) {
        const arc = this._settings.get_string('sidebar-layout') === 'arc';
        this._side = arc ? new ArcSidebar(this._settings, { peek, saved }) : new StageSidebar(this._settings, saved);
        this._side.enable();
    }

    _swapSidebar() {
        if (this._side) this._side.disable();
        this._buildActiveSidebar(true);   // the user just picked it: show where it went
    }

    disable() {
        // The lock screen disables extensions too. Keep stages and maximize origins
        // as plain stable-sequence ids (no GObjects) so they come back on unlock.
        this._lockState = Main.sessionMode.isLocked
            ? { max: this._max?.exportState(), side: this._side?.exportState() }
            : null;
        // Null-guarded: if enable() threw part-way through, one of these is
        // still unset and an unguarded call would throw again out of disable().
        if (this._side) this._side.disable();
        if (this._max) this._max.disable();
        this._side = null;
        this._max = null;
        this._sigSources.forEach(o => o.disconnectObject(this));
        this._sigSources.clear();
        this._settings = null;
    }
}
