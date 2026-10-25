/**
 * Minimal fakes for the gi:// + shell modules that src/extension.js imports,
 * so the pure-logic parts (group state machine, workspace tracking,
 * show/hide state) can be exercised under node.
 */

export const Meta = {
    // Real mutter values (Meta-18). DESKTOP is what Ubuntu's desktop-icons
    // window becomes via set_type(), so it must not alias another type.
    WindowType: { NORMAL: 0, DESKTOP: 1, DOCK: 2, DIALOG: 3 },
    // Only used for instanceof: a press on the bare wallpaper comes from one.
    BackgroundActor: class BackgroundActor {},
    SizeChange: { MAXIMIZE: 0, UNMAXIMIZE: 1 },
    KeyBindingFlags: { NONE: 0 },
    // Real mutter values. Note that meta_window_is_maximized() returns a
    // gboolean, NOT these flags; the per-axis state is on the
    // maximized-horizontally / maximized-vertically properties.
    MaximizeFlags: { HORIZONTAL: 1, VERTICAL: 2, BOTH: 3 },
};

/**
 * Enough of ClutterActor for the card/thumbnail builders to run: geometry
 * setters, a child list, and destruction. Not a layout engine; width/height are
 * whatever was last set, which is all the thumbnail maths depends on.
 */
class FakeActor {
    constructor(p = {}) {
        this.width = 0; this.height = 0; this.x = 0; this.y = 0;
        this.children = [];
        this.destroyed = false;
        this.visible = true;
        this.styleClass = p.style_class ?? null;
        Object.assign(this, p);
    }
    set_size(w, h) { this.width = w; this.height = h; }
    get_size() { return [this.width, this.height]; }
    // Natural size == set size in this fake; there's no real CSS/layout
    // engine, so "preferred" and "allocated" are the same thing here.
    get_preferred_size() { return [this.width, this.height, this.width, this.height]; }
    set_position(x, y) { this.x = x; this.y = y; }
    get_position() { return [this.x, this.y]; }
    add_child(c) { this.children.push(c); c.parent = this; }
    insert_child_below(c, sibling) {
        const i = this.children.indexOf(sibling);
        this.children.splice(i < 0 ? 0 : i, 0, c);
        c.parent = this;
    }
    remove_child(c) { this.children = this.children.filter(k => k !== c); }
    get_children() { return [...this.children]; }
    // sibling === null moves child to the end of the list (top of paint order),
    // matching real Clutter.Actor.set_child_above_sibling semantics.
    set_child_above_sibling(child, sibling) {
        this.children = this.children.filter(k => k !== child);
        if (sibling === null || sibling === undefined) this.children.push(child);
        else this.children.splice(this.children.indexOf(sibling) + 1, 0, child);
    }
    get_parent() { return this.parent ?? null; }
    destroy_all_children() { this.children.forEach(c => c.destroy()); this.children = []; }
    destroy() { this.destroyed = true; this.parent?.remove_child(this); }
    set_pivot_point() {}
    set_style_class_name(n) { this.styleClass = n; }
    set_opacity(o) { this.opacity = o; }
    set_scale() {}
    ease() {}
    remove_all_transitions() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    // Handlers are recorded so tests can deliver a signal to the real callback.
    connect(sig, cb) {
        this._handlers ??= new Map();
        const id = (this._nextId = (this._nextId ?? 0) + 1);
        this._handlers.set(id, { sig, cb });
        return id;
    }
    disconnect(id) { this._handlers?.delete(id); }
    // Models GJS's connectObject()/disconnectObject(): every connection made
    // with a given tracking object is disconnected together, in one call.
    connectObject(sig, cb, trackingObj) {
        const id = this.connect(sig, cb);
        this._tracked ??= new Map();
        const ids = this._tracked.get(trackingObj) ?? [];
        ids.push(id);
        this._tracked.set(trackingObj, ids);
    }
    disconnectObject(trackingObj) {
        const ids = this._tracked?.get(trackingObj);
        if (!ids) return;
        ids.forEach(id => this.disconnect(id));
        this._tracked.delete(trackingObj);
    }
    emit(sig, ...args) {
        let ret;
        for (const h of this._handlers?.values() ?? [])
            if (h.sig === sig) ret = h.cb(this, ...args);
        return ret;
    }
    contains(a) {
        if (a === this) return true;
        return this.children.some(c => c.contains?.(a));
    }
    // Stage position = own position plus every ancestor's (no scale or rotation here).
    get_transformed_position() {
        const [px, py] = this.parent?.get_transformed_position?.() ?? [0, 0];
        return [px + this.x, py + this.y];
    }
    /** Stage point → this actor's coordinates, as Clutter returns it: [ok, x, y]. */
    transform_stage_point(x, y) {
        const [tx, ty] = this.get_transformed_position();
        return [true, x - tx, y - ty];
    }
    get_transformed_extents() {
        const [x, y] = this.get_transformed_position();
        return { origin: { x, y }, size: { width: this.width, height: this.height } };
    }
}

export const Clutter = {
    ActorAlign: { CENTER: 0, START: 1 },
    AnimationMode: { EASE_OUT_QUAD: 0, EASE_OUT_CUBIC: 1 },
    Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
    // Real Clutter values: SMOOTH must not collide with UP/DOWN or the
    // delta-vs-direction branch in _onScrollEvent() is untested.
    ScrollDirection: { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, SMOOTH: 4 },
    PickMode: { REACTIVE: 0, ALL: 1 },
    // Real Clutter value (1 << 8); the arc drag poll masks against it.
    ModifierType: { BUTTON1_MASK: 256 },
    BUTTON_PRIMARY: 1,
    // Real Clutter value: a click that moves focus is dispatched as type 6.
    EventType: { BUTTON_PRESS: 6 },
    get_current_event: () => currentEvent,
    PolicyType: { NEVER: 0 },
    EVENT_STOP: true,
    EVENT_PROPAGATE: false,
    Clone: class Clone extends FakeActor {
        // Real Clutter.Clone exposes set_source(); _nullCloneSources() calls it
        // when tearing down thumbnails so the clone stops referencing the window.
        set_source(src) { this.source = src; }
    },
};

export const St = {
    // Real values, as introspected from St-18. NEVER must not be 0 or a test
    // comparing against it silently passes either way.
    PolicyType: { ALWAYS: 0, AUTOMATIC: 1, NEVER: 2, EXTERNAL: 3 },
    SystemColorScheme: { DEFAULT: 0, PREFER_DARK: 1, PREFER_LIGHT: 2 },
    ThemeContext: { get_for_stage: () => ({ scale_factor: 1, connect: () => 1, disconnect: () => {}, connectObject: () => {}, disconnectObject: () => {} }) },
    Settings: { get: () => ({ color_scheme: 0, connect: () => 1, disconnect: () => {}, connectObject: () => {}, disconnectObject: () => {} }) },
    Widget: class Widget extends FakeActor {},
    BoxLayout: class BoxLayout extends FakeActor {},
    ScrollView: class ScrollView extends FakeActor {
        constructor(p = {}) {
            super(p);
            // Modelled on St: a scrollable range only exists when the policy
            // permits scrolling in that direction.
            this.vadjustment = { value: 0, upper: 0, page_size: 0 };
            this.hadjustment = { value: 0, upper: 0, page_size: 0 };
        }
        set_child(c) { this.child = c; this.add_child(c); }
        /**
         * Give the adjustment a range, as St would once content overflows.
         * With PolicyType.NEVER St does not scroll that direction, so the
         * adjustment stays pinned to the viewport and `upper - page_size` is 0.
         */
        setContentHeight(contentH, viewportH) {
            const scrollable = this.vscrollbar_policy !== St.PolicyType.NEVER;
            this.vadjustment.page_size = viewportH;
            this.vadjustment.upper = scrollable ? contentH : viewportH;
        }
        /** Same, for the horizontal axis a bottom strip scrolls on. */
        setContentWidth(contentW, viewportW) {
            const scrollable = this.hscrollbar_policy !== St.PolicyType.NEVER;
            this.hadjustment.page_size = viewportW;
            this.hadjustment.upper = scrollable ? contentW : viewportW;
        }
    },
    Label: class Label extends FakeActor {},
    Bin: class Bin extends FakeActor {},
};

export { FakeActor };

/* ── Controllable clock so tests decide when timers fire ─────────────── */

class Clock {
    constructor() { this.timers = new Map(); this.next = 1; this.now = 0; this._dispatching = new Set(); }
    add(ms, cb) { const id = this.next++; this.timers.set(id, { at: this.now + ms, ms, cb }); return id; }
    // Real GLib tolerates a source removing itself while its own callback is
    // still dispatching (e.g. _hidePanel() calling _cancelHide() on the very
    // hide-timer whose callback invoked it); only a *stale* id from an
    // earlier, already-finished tick is a genuine bug worth throwing on.
    remove(id) {
        if (this._dispatching.has(id)) return;
        if (!this.timers.has(id))
            throw new Error(`source_remove on unknown/already-removed id ${id}`);
        this.timers.delete(id);
    }
    // A callback returning GLib.SOURCE_CONTINUE (true) is re-armed under the
    // same id at now+ms, mirroring a real repeating GLib.timeout_add; the
    // snapshot in [...this.timers] means a timer re-armed mid-loop can't
    // refire within the same advance() call.
    advance(ms) {
        this.now += ms;
        for (const [id, t] of [...this.timers]) {
            if (t.at <= this.now && this.timers.has(id)) {
                this.timers.delete(id);
                this._dispatching.add(id);
                const ret = t.cb();
                this._dispatching.delete(id);
                if (ret === true) this.timers.set(id, { at: this.now + t.ms, ms: t.ms, cb: t.cb });
            }
        }
    }
    get pending() { return this.timers.size; }
    reset() { this.timers.clear(); this._dispatching.clear(); this.now = 0; }
}

export const clock = new Clock();

export const GLib = {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    SOURCE_CONTINUE: true,
    timeout_add: (_prio, ms, cb) => clock.add(ms, cb),
    source_remove: id => clock.remove(id),
};

/* ── Fake window / workspace / workspace-manager ─────────────────────── */

let winSeq = 0;

export class FakeWindow {
    /**
     * `actor` opts a window into having a compositor actor, so the thumbnail and
     * snapshot paths can be exercised. `frame` is the window frame inside it,
     * the gap between the two is the CSD shadow margin that must be trimmed.
     */
    constructor(appId, {
        minimized = false, type = Meta.WindowType.NORMAL,
        actor = null, frame = { x: 0, y: 0, width: 800, height: 600 },
        maximizedH = true, maximizedV = true, sticky = false,
    } = {}) {
        this._id = ++winSeq;
        this.appId = appId;
        this.minimized = minimized;
        this._type = type;
        this.skip_taskbar = false;
        this._userTime = this._id;
        this._ws = null;
        this.activated = 0;
        this._frame = frame;
        this._actor = actor;
        // Per-axis maximize state, the way mutter exposes it. Both true = a full
        // maximize; one true = an edge-tiled (half-screen) window.
        this.maximized_horizontally = maximizedH;
        this.maximized_vertically = maximizedV;
        /** On all workspaces by the user's choice (window menu), not by type. */
        this.sticky = sticky;
        /** Signal emissions the compositor would deliver asynchronously. */
        this.pending = [];
        this._sigs = [];
    }

    // GObject signals on the window itself ('unmanaged'), with connectObject().
    connectObject(sig, cb, owner) { this._sigs.push({ sig, cb, owner }); }
    disconnectObject(owner) { this._sigs = this._sigs.filter(h => h.owner !== owner); }
    get signalCount() { return this._sigs.length; }
    /** Closed. Like mutter, no wm 'destroy' effect is implied: that only runs for
     *  a window visible at the time. 'unmanaged' always fires; the workspace is gone. */
    unmanage() {
        if (this._ws) this._ws.windows = this._ws.windows.filter(w => w !== this);
        this._ws = null;
        for (const h of [...this._sigs]) if (h.sig === 'unmanaged') h.cb(this);
    }

    /** meta_window_raise(): mutter calls it on every plain click, focused or not. */
    raise() { for (const h of [...this._sigs]) if (h.sig === 'raised') h.cb(this); }

    get_id() { return this._id; }
    /** Per-session window counter, NOT stable across logins (see mutter docs). */
    get_stable_sequence() { return this._id; }
    /** Mirrors meta_window_is_maximized(): a gboolean, not a flags value. */
    is_maximized() { return this.maximized_horizontally && this.maximized_vertically; }
    get_window_type() { return this._type; }
    is_attached_dialog() { return false; }
    is_always_on_all_workspaces() { return false; }
    is_on_all_workspaces() { return this.sticky; }
    /** False for a window mutter refuses to minimize (no minimize function). */
    can_minimize() { return this.canMinimize ?? true; }
    get_user_time() { return this._userTime; }
    get_workspace() { return this._ws; }
    get_compositor_private() { return this._actor; }
    get_frame_rect() { return this._frame; }
    activate() { this.activated++; this._userTime = ++winSeq; }

    // Minimize/unminimize are async in the compositor: state flips, but the wm
    // signal is queued until the test flushes it.
    // Like mutter, a window that can't be minimized refuses (mutter also warns).
    minimize() { if (this.minimized || !this.can_minimize()) return; this.minimized = true; this.pending.push('minimize'); }
    unminimize() { if (!this.minimized) return; this.minimized = false; this.pending.push('unminimize'); }

    change_workspace_by_index(i, _append) { wsm.get_workspace_by_index(i)?.adopt(this); }
    change_workspace(ws) { ws.adopt(this); }
}

export class FakeWorkspace {
    constructor(label) { this.label = label; this.windows = []; this.activations = 0; }
    list_windows() { return [...this.windows]; }
    index() { return wsm.workspaces.indexOf(this); }
    activate() { this.activations++; wsm.activeIndex = this.index(); }
    get active() { return wsm.get_active_workspace() === this; }
    adopt(win) {
        if (win._ws) win._ws.windows = win._ws.windows.filter(w => w !== win);
        win._ws = this;
        this.windows.push(win);
    }
}

class FakeWorkspaceManager {
    constructor() { this.workspaces = []; this.activeIndex = 0; }
    reset(n) {
        this.workspaces = Array.from({ length: n }, (_, i) => new FakeWorkspace(`ws${i}`));
        this.activeIndex = 0;
        return this.workspaces;
    }
    get_n_workspaces() { return this.workspaces.length; }
    get_workspace_by_index(i) { return this.workspaces[i] ?? null; }
    get_active_workspace_index() { return this.activeIndex; }
    get_active_workspace() { return this.workspaces[this.activeIndex]; }
    append_new_workspace(_activate, _time) {
        const ws = new FakeWorkspace(`ws${this.workspaces.length}`);
        this.workspaces.push(ws);
        return ws;
    }
    /** Model mutter reaping an empty workspace: indices after it shift down. */
    removeWorkspace(ws) {
        // Like mutter: the active workspace stays the same object, its index shifts.
        const active = this.workspaces[this.activeIndex];
        this.workspaces = this.workspaces.filter(w => w !== ws);
        this.activeIndex = Math.max(0, this.workspaces.indexOf(active));
    }
    setActive(ws) { this.activeIndex = this.workspaces.indexOf(ws); }
}

export const wsm = new FakeWorkspaceManager();

/* ── Signal-emitting fakes for global.* ──────────────────────────────── */

class Emitter {
    constructor(name) { this.name = name; this._h = new Map(); this._seq = 1; }
    connect(sig, cb) { const id = this._seq++; this._h.set(id, { sig, cb }); return id; }
    disconnect(id) {
        if (!this._h.has(id)) throw new Error(`${this.name}: disconnect of unknown id ${id}`);
        this._h.delete(id);
    }
    // Models GJS's connectObject()/disconnectObject(): every connection made
    // with a given tracking object is disconnected together, in one call.
    connectObject(sig, cb, trackingObj) {
        const id = this.connect(sig, cb);
        this._tracked ??= new Map();
        const ids = this._tracked.get(trackingObj) ?? [];
        ids.push(id);
        this._tracked.set(trackingObj, ids);
    }
    disconnectObject(trackingObj) {
        const ids = this._tracked?.get(trackingObj);
        if (!ids) return;
        ids.forEach(id => this.disconnect(id));
        this._tracked.delete(trackingObj);
    }
    emit(sig, ...args) {
        for (const { sig: s, cb } of [...this._h.values()])
            if (s === sig) cb(this, ...args);
    }
    get count() { return this._h.size; }
    clear() { this._h.clear(); }
}

export const windowManager = new Emitter('window_manager');
export const display = new Emitter('display');
export const wsmEmitter = new Emitter('workspace_manager');
export const stage = new Emitter('stage');
export const windowGroup = new Emitter('window_group');

/**
 * A stand-in MetaWindowActor: `size` is the actor including shadow margins, and
 * `at` is where it sits, so the frame offset inside it is derivable.
 * `paint_to_content()` hands back an identifiable token.
 */
export function makeWindowActor({ size = [860, 660], at = [-30, -20] } = {}) {
    const actor = new FakeActor();
    actor.set_size(size[0], size[1]);
    actor.set_position(at[0], at[1]);
    actor.paintCount = 0;
    actor.paint_to_content = _clip => {
        actor.paintCount++;
        return { token: `content-${actor.paintCount}` };
    };
    return actor;
}

/** Deliver any queued minimize/unminimize signals for `wins` to a sidebar. */
export function deliver(sidebar, wins) {
    for (const win of wins) {
        for (const sig of win.pending.splice(0)) {
            if (sig === 'minimize') sidebar._onWindowMinimize(win);
            else sidebar._onWindowUnminimize(win);
        }
    }
}

/** Which window `global.display.get_focus_window()` reports. */
let focusedWindow = null;

/** Set the focused window (modes that hide "what you're already looking at"
 *  depend on it). Pass null for "nothing focused". */
export function setFocus(win) {
    focusedWindow = win ?? null;
}

/** Full isolation between tests: no leaked handlers, no leaked timers. */
/** The event Clutter is dispatching right now (null outside dispatch). */
let currentEvent = null;
export function setCurrentEvent(ev) { currentEvent = ev; }

/** Stage-coordinate pointer position, driven by setPointer() in tests. */
let pointerPos = [0, 0, 0];
export function setPointer(x, y, mask = 0) { pointerPos = [x, y, mask]; }

export function setMonitors(mons, primaryIndex = 0) {
    Main.layoutManager.monitors = mons;
    Main.layoutManager.primaryIndex = primaryIndex;
}

export function resetHarness() {
    Main.sessionMode.isLocked = false;
    pointerPos = [0, 0, 0];
    currentEvent = null;
    Main.layoutManager.monitors = [{ x: 0, y: 0, width: 1920, height: 1080, index: 0 }];
    Main.layoutManager.primaryIndex = 0;
    Main.layoutManager.lastWorkAreaIndex = null;
    windowManager.clear();
    display.clear();
    wsmEmitter.clear();
    stage.clear();
    stage._actorAtPos = null;
    windowGroup.clear();
    Main.actionMode = Shell.ActionMode.NORMAL;
    Main.wm.moves = [];
    clock.reset();
    focusedWindow = null;
}

export const Shell = {
    // Real Shell values; POPUP is what a menu grab puts the shell in.
    ActionMode: { NORMAL: 1, OVERVIEW: 2, POPUP: 128 },
    WindowTracker: {
        get_default: () => ({
            get_window_app: win => win.appId
                ? {
                    get_id: () => win.appId,
                    get_name: () => win.appId,
                    // Must be a real actor: the card builders position and parent it.
                    create_icon_texture: size => {
                        const icon = new FakeActor();
                        icon.set_size(size, size);
                        return icon;
                    },
                }
                : null,
        }),
    },
};

export const Main = {
    panel: { height: 32 },
    layoutManager: {
        // Single 1080p monitor by default; setMonitors() swaps in a multi-head
        // arrangement so index-handling bugs can't hide behind "index 0 is the
        // only index there is".
        monitors: [{ x: 0, y: 0, width: 1920, height: 1080, index: 0 }],
        primaryIndex: 0,
        get primaryMonitor() { return Main.layoutManager.monitors[Main.layoutManager.primaryIndex] ?? null; },
        /** Records the index it was asked about, so tests can assert on it. */
        getWorkAreaForMonitor(idx) {
            Main.layoutManager.lastWorkAreaIndex = idx;
            const mon = Main.layoutManager.monitors[idx] ?? Main.layoutManager.monitors[0];
            return { x: mon.x, y: mon.y + Main.panel.height, width: mon.width, height: mon.height - Main.panel.height };
        },
        lastWorkAreaIndex: null,
        addChrome: () => {},
        removeChrome: () => {},
        connect: () => 1,
        disconnect: () => {},
        connectObject: () => {},
        disconnectObject: () => {},
    },
    wm: {
        addKeybinding: () => 1, removeKeybinding: () => {},
        // windowManager.js: move the window and follow it, as one animated switch.
        moves: [],
        actionMoveWindow(win, ws) {
            this.moves.push([win, ws]);
            if (!ws.active) { win.change_workspace(ws); ws.activate(); }
        },
    },
    uiGroup: new FakeActor(),
    actionMode: 1,
    // True while the lock screen is up; the shell disables extensions then.
    sessionMode: { isLocked: false },
    // ArcSidebar tracks overview show/hide so it can re-show only the focused
    // window's group on the way out.
    overview: {
        connectObject: () => {},
        disconnectObject: () => {},
    },
};

export class Extension {
    constructor() { this._fakeSettings = null; }
    getSettings() { return this._fakeSettings; }
}

// The real ones resolve the domain through the shell's extension registry, which
// does not exist here. Identity is enough; the tests assert behaviour, not
// translations.
export const gettext = s => s;
export const ngettext = (s, plural, n) => (n === 1 ? s : plural);

/* ── GSettings fake ──────────────────────────────────────────────────── */

const DEFAULTS = {
    'maximize-behavior': 'workspace',
    'maximize-migrated': true,
    'enable-maximize-to-workspace': true,   // deprecated, read only by the migration
    'maximize-to-new-group': false,         // deprecated, read only by the migration
    'sidebar-width': 220,
    'animation-duration': 250,
    'sidebar-auto-hide': false,
    'sidebar-reserve-space': false,
    'auto-hide-delay': 800,
    'edge-trigger-width': 4,
    'edge-trigger-delay': 250,
    'show-app-icons': true,
    'sidebar-mode': 'groups',
    'card-base-scale': 70,
    'perspective-angle': 22,
    'show-group-count': true,
    'show-workspace-current': true,
    'show-on-empty-workspace': true,
    'toggle-sidebar': [],
    'keybinding-show-desktop': [],
    'sidebar-hide-when-covered': true,
    'park-on-desktop-click': true,
    'arc-angle-step': 16,
    'sidebar-layout': 'stack',
    'app-merge-map': '{}',
    'stack-panel-position': 'left',
    'arc-panel-position': 'left',
    'arc-persistent-mode': false,
    'arc-card-scale': 100,
    'arc-scroll-speed': 10,
    'arc-merge-map': '{}',
    'arc-order-map': '{}',
    'keybinding-arc-next': [],
    'keybinding-arc-prev': [],
    'keybinding-arc-activate': [],
    'keybinding-arc-close': [],
    // Added by the Tahoe PR; values mirror the gschema defaults.
    'arc-hover-fan-delay': 350,
    'arc-fan-hold': true,
    'arc-fan-hold-delay': 800,
    'arc-hide-active': false,
    'arc-keep-visible': true,
    'arc-show-in-overview': true,
    'arc-overview-merge': true,
};

export function makeSettings(overrides = {}) {
    const values = { ...DEFAULTS, ...overrides };
    const em = new Emitter('settings');
    return {
        get_boolean: k => values[k],
        get_int: k => values[k],
        get_string: k => values[k],
        get_strv: k => values[k],
        set: (k, v) => { values[k] = v; em.emit(`changed::${k}`); },
        set_string: (k, v) => { values[k] = v; em.emit(`changed::${k}`); },
        connect: (s, cb) => em.connect(s, cb),
        disconnect: id => em.disconnect(id),
        connectObject: (s, cb, t) => em.connectObject(s, cb, t),
        disconnectObject: t => em.disconnectObject(t),
        _emitter: em,
    };
}

/** Install the fake globals that extension.js reads off `global`. */
export function installGlobals() {
    globalThis.global = {
        window_manager: windowManager,
        window_group: windowGroup,
        workspace_manager: Object.assign(wsm, {
            connect: (s, cb) => wsmEmitter.connect(s, cb),
            disconnect: id => wsmEmitter.disconnect(id),
            connectObject: (s, cb, t) => wsmEmitter.connectObject(s, cb, t),
            disconnectObject: t => wsmEmitter.disconnectObject(t),
        }),
        display: Object.assign(display, {
            get_focus_window: () => focusedWindow,
            list_all_windows: () => [...new Set(wsm.workspaces.flatMap(ws => ws.windows))],
            // Strict on purpose: the real binding takes a gint, so a monitor
            // object built without `index` throws instead of silently reporting
            // "not fullscreen".
            get_monitor_in_fullscreen: idx => {
                if (!Number.isInteger(idx))
                    throw new TypeError(`get_monitor_in_fullscreen expects an integer index, got ${idx}`);
                return false;
            },
            // _getMon() reads geometry from the compositor, not layoutManager;
            // mirror the same single monitor so both paths agree.
            get_primary_monitor: () => Main.layoutManager.primaryMonitor.index,
            get_n_monitors: () => Main.layoutManager.monitors.length,
            get_monitor_geometry: idx => {
                const mon = Main.layoutManager.monitors[idx];
                if (!mon) throw new RangeError(`no monitor at index ${idx}`);
                return { x: mon.x, y: mon.y, width: mon.width, height: mon.height };
            },
        }),
        stage: Object.assign(stage, {
            // Tests drive this by setting stage._actorAtPos directly; there's
            // no real geometry in this fake, so it can't hit-test from x/y.
            get_actor_at_pos: () => stage._actorAtPos ?? null,
            // Tests pass events carrying the actor they "came from".
            get_event_actor: ev => ev?._source ?? null,
        }),
        get_pointer: () => pointerPos,
        get_current_time: () => ++winSeq,
    };
}
