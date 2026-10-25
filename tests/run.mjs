/**
 * Regression tests for the defects fixed in v1.4.0. Each was written to FAIL
 * against the code before its fix.
 *
 * Run: make test   (or: node tests/build.mjs && node tests/run.mjs)
 */
import assert from 'node:assert/strict';
import {
    Meta, St, Clutter, clock, wsm, windowManager,
    FakeWindow, makeWindowActor, makeSettings, installGlobals, deliver, resetHarness,
    setFocus, Main, stage, setPointer, setMonitors, windowGroup, display, Shell, setCurrentEvent,
} from './stubs.mjs';

installGlobals();

const { MaximizeToWorkspace, StageSidebar, ArcSidebar, StageManagerExtension, _groupByApp } = await import('./ext-under-test.mjs');

/* ── tiny runner ─────────────────────────────────────────────────────── */

const results = [];
function test(name, fn) {
    resetHarness();
    try { fn(); results.push(['PASS', name]); }
    catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); }
    finally { resetHarness(); }
}

/** A StageSidebar with all rendering/UI methods neutralised. */
function makeSidebar(settings) {
    const s = new StageSidebar(settings);
    s._refresh = () => { s._refreshCount = (s._refreshCount ?? 0) + 1; };
    s._destroyPreview = () => {};
    s._resetAllCardScales = () => {};
    s._scheduleHide = () => {};
    s._visible = false;
    return s;
}

/** The group key ArcSidebar derives for a window (see _windowKey). */
function arc0WindowKey(win) { return `w${win.get_stable_sequence()}`; }

/** What the 'active-workspace-changed' handler in _wire() does. */
function switchWorkspace(sidebar, ws) {
    wsm.setActive(ws);
    sidebar._initGroups();
}

function fakeActor() {
    return {
        x: 0, y: 0, _t: null, visible: true,
        ease(p) { this._t = p; },
        remove_all_transitions() { this._t = null; },
        set_position(nx, ny) { this.x = nx; this.y = ny; },
        set_size() {},
        hide() { this.visible = false; },
        show() { this.visible = true; },
        // Natural completion: Clutter only invokes onComplete when a transition
        // finishes, never when it is removed.
        finish() { const t = this._t; this._t = null; if (t) { if ('x' in t) this.x = t.x; t.onComplete?.(); } },
        get targetX() { return this._t ? this._t.x : null; },
        get animating() { return this._t !== null; },
    };
}

/* ═══ #5: groups must be scoped to the active workspace ═════════════ */

test('#5 a window mapped on another workspace does not join the active stage', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);

    const a = new FakeWindow('appA'); ws0.adopt(a);
    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();

    const b = new FakeWindow('appB'); ws1.adopt(b);
    sidebar._onWindowMap(b);

    const active = sidebar._getActiveGroup();
    assert.ok(active, 'expected an active group');
    assert.ok(!active.windows.has(b),
        'window living on ws1 was added to the ws0 active stage');
});

test('#5 swapping stages never touches windows on other workspaces', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);

    const a = new FakeWindow('appA'); ws0.adopt(a);
    const other = new FakeWindow('appB'); ws1.adopt(other);
    const parked = new FakeWindow('appC', { minimized: true }); ws0.adopt(parked);

    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    sidebar._onWindowMap(other);

    const target = sidebar._groups.find(g => g.windows.has(parked));
    sidebar._swapToGroup(target);

    assert.equal(other.minimized, false,
        'a window on ws1 was minimized by a stage swap on ws0');
});

/* ═══ #6: stage arrangement must survive a workspace round-trip ═════ */

test('#6 separate stages of the same app survive a workspace round-trip', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);

    const a = new FakeWindow('appA');
    const b = new FakeWindow('appX');
    const c = new FakeWindow('appX');
    [a, b, c].forEach(w => ws0.adopt(w));

    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();

    b.minimize(); deliver(sidebar, [b]);
    c.minimize(); deliver(sidebar, [c]);
    assert.equal(sidebar._getInactiveGroups().length, 2, 'precondition: two parked stages');

    switchWorkspace(sidebar, ws1);
    switchWorkspace(sidebar, ws0);

    assert.equal(sidebar._getInactiveGroups().length, 2,
        'two same-app stages were merged into one by the workspace round-trip');
});

test('#6 the active stage is re-derived correctly for each workspace', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);

    const a = new FakeWindow('appA'); ws0.adopt(a);
    const b = new FakeWindow('appB'); ws1.adopt(b);

    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    assert.ok(sidebar._getActiveGroup().windows.has(a), 'precondition: ws0 active stage holds a');

    switchWorkspace(sidebar, ws1);
    const active = sidebar._getActiveGroup();
    assert.ok(active.windows.has(b), 'ws1 active stage should hold b');
    assert.ok(!active.windows.has(a), 'ws1 active stage must not hold a window from ws0');
});

/* ═══ #7: swap guard must not swallow real user minimizes ═══════════ */

test('#7 a user minimize during the swap window still creates a stage card', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);

    const a = new FakeWindow('appA');
    const c = new FakeWindow('appC');
    const b = new FakeWindow('appB', { minimized: true });
    [a, c, b].forEach(w => ws0.adopt(w));

    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();

    const target = sidebar._groups.find(g => g.windows.has(b));
    sidebar._swapToGroup(target);
    deliver(sidebar, [a, c, b]);

    b.minimize();
    deliver(sidebar, [b]);

    const reachable = sidebar._getInactiveGroups().some(g => g.windows.has(b));
    assert.ok(reachable,
        'user-minimized window is in no inactive stage, unreachable from the sidebar');
});

test('#7 a stage swap\'s own minimizes never split the outgoing stage', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);

    const a = new FakeWindow('appA');
    const c = new FakeWindow('appC');
    const b = new FakeWindow('appB', { minimized: true });
    [a, c, b].forEach(w => ws0.adopt(w));

    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    const before = sidebar._groups.length;

    const target = sidebar._groups.find(g => g.windows.has(b));
    sidebar._swapToGroup(target);

    // Compositor delivers the swap's signals LATE, after any time-based guard
    // would have expired.
    clock.advance(1000);
    deliver(sidebar, [a, c, b]);

    assert.equal(sidebar._groups.length, before,
        'late swap signals split the outgoing stage into extra groups');
    const outgoing = sidebar._groups.find(g => g.windows.has(a));
    assert.ok(outgoing && outgoing.windows.has(c),
        'outgoing stage lost a window to a late minimize signal');
});

/* ═══ moved windows must not keep a stale stage membership ═══════════ */

test('a window moved to another workspace ends up in exactly one stage', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);

    const w = new FakeWindow('appA'); ws0.adopt(w);
    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    assert.ok(sidebar._getActiveGroup().windows.has(w), 'precondition: in ws0 active stage');

    ws1.adopt(w);            // user drags it to ws1
    w.minimized = true;      // ...and it is restored there
    sidebar._onWindowUnminimize(w);

    const holders = sidebar._groups.filter(g => g.windows.has(w));
    assert.equal(holders.length, 1,
        `window is a member of ${holders.length} stages at once`);
    assert.equal(holders[0].ws.label, ws1.label,
        'the surviving stage is tagged with the wrong workspace');
});

test('a window minimized after moving workspace is reachable on its new workspace', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);

    const w = new FakeWindow('appA');
    const keep = new FakeWindow('appB');
    ws0.adopt(w); ws0.adopt(keep);

    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();

    ws1.adopt(w);            // moved away, no workspace switch yet
    wsm.setActive(ws1);
    w.minimize(); deliver(sidebar, [w]);

    const reachable = sidebar._getInactiveGroups().some(g => g.windows.has(w));
    assert.ok(reachable,
        'parked window has no card on the workspace it actually lives on');
});

test('switching workspace sweeps windows out of stages they left', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);

    const w = new FakeWindow('appA'); ws0.adopt(w);
    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();

    ws1.adopt(w);
    switchWorkspace(sidebar, ws1);

    const stale = sidebar._groups.filter(g => g.ws === ws0 && g.windows.has(w));
    assert.equal(stale.length, 0, 'a ws0 stage still holds a window that moved to ws1');
});

/* ═══ #3: show/hide must be interruptible ══════════════════════════ */

test('#3 hovering the edge during the hide animation re-shows the sidebar', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'sidebar-auto-hide': true }));
    sidebar._panel = fakeActor();
    sidebar._edge = fakeActor();
    sidebar._fullscreen = () => false;

    sidebar._show();
    sidebar._panel.finish();
    assert.equal(sidebar._visible, true, 'precondition: shown');

    sidebar._hide();
    assert.ok(sidebar._panel.animating, 'precondition: hide animating');

    sidebar._show();
    assert.equal(sidebar._visible, true,
        '_show() during the hide animation was ignored; sidebar stays hidden');
    assert.equal(sidebar._panel.targetX, 0, 'panel is not easing back on-screen');
});

test('#3 hide during the show animation still hides', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'sidebar-auto-hide': true }));
    sidebar._panel = fakeActor();
    sidebar._edge = fakeActor();
    sidebar._fullscreen = () => false;

    sidebar._show();
    assert.ok(sidebar._panel.animating, 'precondition: show animating');
    sidebar._hide();
    assert.equal(sidebar._visible, false, '_hide() during show was ignored');
    assert.equal(sidebar._panel.targetX, -220, 'panel is not easing off-screen');
});

/* ═══ #11: leaving fullscreen restores an always-visible sidebar ════ */

test('#11 leaving fullscreen restores the sidebar when auto-hide is off', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'sidebar-auto-hide': false }));
    sidebar._panel = fakeActor();
    sidebar._edge = fakeActor();
    let fs = false;
    sidebar._fullscreen = () => fs;

    sidebar._show();
    sidebar._panel.finish();

    fs = true; sidebar._onFullscreen();
    assert.equal(sidebar._visible, false, 'precondition: hidden while fullscreen');

    fs = false; sidebar._onFullscreen();
    assert.equal(sidebar._visible, true,
        'always-visible sidebar did not come back after leaving fullscreen');
});

/* ═══ #4: the edge trigger is only live when it is needed ═══════════ */

test('#4 the edge trigger is hidden while the sidebar is on screen', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'sidebar-auto-hide': true }));
    sidebar._panel = fakeActor();
    sidebar._edge = fakeActor();
    sidebar._fullscreen = () => false;

    sidebar._show();
    assert.equal(sidebar._edge.visible, false,
        'edge strip still eats input while the sidebar is visible');
    sidebar._hide();
    assert.equal(sidebar._edge.visible, true, 'edge strip must be live once hidden');
});

/* ═══ #2: edge dwell: brushing past must not open the sidebar ═══════ */

/** Build far enough to get a wired, reactive _edge, with _show() recorded
 *  rather than animated. */
function edgeSidebar(delay) {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'edge-trigger-delay': delay }));
    sidebar._build();
    sidebar._fullscreen = () => false;
    sidebar._shown = 0;
    sidebar._show = () => { sidebar._shown++; };
    return sidebar;
}

test('#2 resting on the edge for the full dwell reveals the sidebar', () => {
    const sidebar = edgeSidebar(250);
    sidebar._edge.emit('enter-event');
    assert.equal(sidebar._shown, 0, 'must not reveal before the dwell elapses');
    clock.advance(250);
    assert.equal(sidebar._shown, 1, 'a deliberate dwell must reveal');
});

test('#2 brushing past the edge cancels the pending reveal', () => {
    const sidebar = edgeSidebar(250);
    sidebar._edge.emit('enter-event');
    assert.ok(sidebar._edgeTimer, 'enter must arm the dwell timer');
    // Pointer moves on to the app's own left-edge UI before the dwell is up.
    sidebar._edge.emit('leave-event');
    assert.equal(sidebar._edgeTimer, null, 'leave must disarm the dwell timer');
    clock.advance(1000);
    assert.equal(sidebar._shown, 0, 'a brush-past must never reveal the sidebar');
});

test('#2 a delay of 0 keeps the original instant reveal, with no timer', () => {
    const sidebar = edgeSidebar(0);
    sidebar._edge.emit('enter-event');
    assert.equal(sidebar._shown, 1, 'delay 0 must reveal synchronously');
    assert.equal(sidebar._edgeTimer, null, 'delay 0 must not arm a timer at all');
});

test('#2 re-entering the edge re-arms rather than stacking dwell timers', () => {
    const sidebar = edgeSidebar(250);
    sidebar._edge.emit('enter-event');
    const first = sidebar._edgeTimer;
    sidebar._edge.emit('enter-event');
    assert.notEqual(sidebar._edgeTimer, first, 'second enter must arm a fresh timer');
    assert.equal(sidebar._timers.filter(id => id === first).length, 0,
        'the superseded timer must be untracked (EGO-L-007)');
    clock.advance(250);
    assert.equal(sidebar._shown, 1, 'only one reveal, not one per enter');
});

test('#2 the dwell timer is tracked in _timers and cleared by disable()', () => {
    const sidebar = edgeSidebar(250);
    sidebar._edge.emit('enter-event');
    assert.ok(sidebar._timers.includes(sidebar._edgeTimer),
        'every timeout id must live in this._timers (EGO round 4)');
    sidebar.disable();
    assert.equal(sidebar._edgeTimer, null, 'disable() must clear the dwell timer');
    assert.equal(sidebar._timers.length, 0, 'disable() must drain the timer array');
});

test('#2 a window going fullscreen during the dwell suppresses the reveal', () => {
    const sidebar = edgeSidebar(250);
    sidebar._edge.emit('enter-event');
    sidebar._fullscreen = () => true;
    clock.advance(250);
    assert.equal(sidebar._shown, 0, 'the fullscreen check must be re-run when the timer fires');
});

/* ═══ #17: thumbnails keep aspect ratio and drop the CSD shadow ═════ */

test('#17 the whole window is shown, scaled to fit and never cropped', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    // 1600x1000 actor (1.6:1). Nothing may be clipped away.
    const w = new FakeWindow('appA', { actor: makeWindowActor({ size: [1600, 1000] }) });

    const clone = sidebar._makeWindowClone(w, 170, 110);
    assert.ok(clone, 'expected a clone');

    // 1.6:1 into a 170x110 box is width-limited, so width fills and height follows.
    const scale = Math.min(170 / 1600, 110 / 1000);
    assert.equal(clone.width, Math.round(1600 * scale), 'width should fill the box');
    assert.equal(clone.height, Math.round(1000 * scale), 'height must follow the actor aspect');
    assert.ok(clone.width <= 170 && clone.height <= 110, 'must fit inside the thumbnail box');

    // No cropping: the drawn size must match the actor's full aspect exactly.
    assert.ok(Math.abs(clone.width / clone.height - 1600 / 1000) < 0.02,
        `aspect distorted: ${clone.width}x${clone.height}`);
    assert.equal(clone.get_children().length, 0, 'no clipping wrapper should be involved');
});

test('#17 the preview never magnifies a small window past 1:1', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    const w = new FakeWindow('appA', {
        actor: makeWindowActor({ size: [200, 150], at: [0, 0] }),
        frame: { x: 0, y: 0, width: 200, height: 150 },
    });

    const thumb = sidebar._makeWindowClone(w, 400, 300);        // may upscale
    const preview = sidebar._makeWindowClone(w, 400, 300, 1.0); // must not
    assert.ok(thumb.width > 200, 'thumbnails may fill the card');
    assert.equal(preview.width, 200, 'preview magnified a small window');
});

/* ═══ card layout must fit inside the sidebar ════════════════════════ */

// Mirrors the constants in extension.js / stylesheet.css.
const CARD_PAD_X = 14, STACK_H = 14, CARD_MARGIN = 8, PERSP_HEADROOM = 0.18;

/**
 * Total width a card occupies, and its projected width once rotated.
 * `step` is the per-layer fan-out, which is proportional to the thumbnail.
 * `sf` scales the card padding, which is a logical length like everything else.
 */
function cardWidth(_sidebarW, thumbW, layers, angle, step = thumbW * (STACK_H / 170), sf = 1) {
    const fan = (Math.min(Math.max(layers, 1), 3) - 1) * step;
    const outer = thumbW + fan + 2 * CARD_PAD_X * sf;
    const projected = outer * (1 + (angle / 45) * PERSP_HEADROOM);
    return { outer, projected };
}

test('a card never overflows the sidebar, at any stack depth or angle', () => {
    wsm.reset(1);
    for (const width of [120, 160, 220, 300, 400]) {
        for (const angle of [0, 22, 45]) {
            const sidebar = makeSidebar(makeSettings({
                'sidebar-width': width, 'perspective-angle': angle,
            }));
            for (const layers of [1, 2, 3, 5]) {
                const [tw] = sidebar._thumbSize(layers);
                const { projected } = cardWidth(width, tw, layers, angle);
                assert.ok(projected <= width,
                    `sidebar ${width}px, angle ${angle}°, ${layers} windows: card projects ${projected.toFixed(1)}px`);
            }
        }
    }
});

/* ═══ bottom position: the stack laid out as a horizontal strip ══════ */

const CARD_PAD_Y = 8, STACK_V = 4, ICON_ROW = 22 + 5;

test('bottom: a card never overflows the strip height, at any depth or angle', () => {
    wsm.reset(1);
    for (const thickness of [120, 160, 220, 300, 400]) {
        for (const angle of [0, 22, 45]) {
            const sidebar = makeSidebar(makeSettings({
                'stack-panel-position': 'bottom',
                'sidebar-width': thickness, 'perspective-angle': angle,
            }));
            for (const layers of [1, 2, 3, 5]) {
                const [, th] = sidebar._thumbSize(layers);
                const fan = (Math.min(Math.max(layers, 1), 3) - 1) * th * (STACK_V / 170);
                const outer = th + fan + 2 * CARD_PAD_Y + ICON_ROW;
                const projected = outer * (1 + (angle / 45) * PERSP_HEADROOM);
                assert.ok(projected <= thickness,
                    `strip ${thickness}px, angle ${angle}°, ${layers} windows: card projects ${projected.toFixed(1)}px tall`);
            }
        }
    }
});

test('bottom: the panel spans the monitor width and parks below the screen', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'stack-panel-position': 'bottom', 'sidebar-width': 200 }));
    const mon = Main.layoutManager.primaryMonitor;

    assert.deepEqual(sidebar._panelSize(mon, 32), [mon.width, 200],
        'a bottom strip is monitor-wide and sidebar-width tall');
    assert.deepEqual(sidebar._panelVisiblePos(mon, 32), [mon.x, mon.y + mon.height - 200]);
    assert.deepEqual(sidebar._panelHiddenPos(mon, 32), [mon.x, mon.y + mon.height],
        'hidden parks fully below the bottom edge');
});

test('bottom: the edge strip runs along the bottom, not down the side', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'stack-panel-position': 'bottom', 'edge-trigger-width': 4 }));
    const mon = Main.layoutManager.primaryMonitor;
    const [x, y, w, h] = sidebar._edgeGeom(mon, 32);

    assert.equal(w, mon.width, 'edge spans the full width');
    assert.equal(h, 4, 'edge is only the trigger thickness tall');
    assert.equal(x, mon.x);
    assert.equal(y, mon.y + mon.height - 4);
});

test('bottom: left/right geometry is unchanged (no regression)', () => {
    wsm.reset(1);
    const mon = Main.layoutManager.primaryMonitor;
    const left = makeSidebar(makeSettings({ 'stack-panel-position': 'left', 'sidebar-width': 220 }));
    const right = makeSidebar(makeSettings({ 'stack-panel-position': 'right', 'sidebar-width': 220 }));

    assert.deepEqual(left._panelSize(mon, 32), [220, mon.height - 32]);
    assert.deepEqual(left._panelVisiblePos(mon, 32), [mon.x, mon.y + 32]);
    assert.deepEqual(left._panelHiddenPos(mon, 32), [mon.x - 220, mon.y + 32]);
    assert.deepEqual(right._panelVisiblePos(mon, 32), [mon.x + mon.width - 220, mon.y + 32]);
    assert.deepEqual(right._panelHiddenPos(mon, 32), [mon.x + mon.width, mon.y + 32]);
});

test('bottom: the card strip scrolls horizontally, the column vertically', () => {
    wsm.reset(1);
    const bottom = makeSidebar(makeSettings({ 'stack-panel-position': 'bottom' }));
    bottom._build();
    assert.equal(bottom._scroll.hscrollbar_policy, St.PolicyType.EXTERNAL,
        'EXTERNAL, not NEVER; NEVER leaves the adjustment with no range');
    assert.equal(bottom._scroll.vscrollbar_policy, St.PolicyType.NEVER);

    const side = makeSidebar(makeSettings({ 'stack-panel-position': 'left' }));
    side._build();
    assert.equal(side._scroll.vscrollbar_policy, St.PolicyType.EXTERNAL);
    assert.equal(side._scroll.hscrollbar_policy, St.PolicyType.NEVER);
});

test('bottom: a wheel event moves the horizontal adjustment', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'stack-panel-position': 'bottom' }));
    sidebar._build();
    sidebar._scroll.setContentWidth(3000, 1000);

    sidebar._box.emit('scroll-event', { get_scroll_direction: () => Clutter.ScrollDirection.DOWN });
    assert.ok(sidebar._scroll.hadjustment.value > 0, 'a wheel must drive the strip sideways');
    assert.equal(sidebar._scroll.vadjustment.value, 0, 'the unused axis must stay put');
});

test('bottom: the render fingerprint changes with position, or cards keep the old axis', () => {
    wsm.reset(1);
    const settings = makeSettings({ 'stack-panel-position': 'left' });
    const sidebar = makeSidebar(settings);
    const before = sidebar._renderSignature();
    settings.set('stack-panel-position', 'bottom');
    assert.notEqual(sidebar._renderSignature(), before,
        '_refresh() would skip the rebuild and leave a vertical column on the bottom edge');
});

test('the pre-fix hardcoded 170px thumbnail really did overflow (regression guard)', () => {
    // The old code: fixed 170px thumb + fixed 14px fan-out per layer.
    // Three-deep stack in the default 220px sidebar: 170 + 2*14 + 2*14 = 226.
    const { outer } = cardWidth(220, 170, 3, 22, STACK_H);
    assert.equal(outer, 226);
    assert.ok(outer > 220,
        'the old geometry should be provably too wide, otherwise this guard is meaningless');
});

test('cards keep a uniform width regardless of stack depth', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'sidebar-width': 220, 'perspective-angle': 22 }));
    const widths = [1, 2, 3].map(n => {
        const [tw] = sidebar._thumbSize(n);
        return cardWidth(220, tw, n, 22).outer;
    });
    // Sub-pixel differences are just integer rounding of the thumbnail width.
    const spread = Math.max(...widths) - Math.min(...widths);
    assert.ok(spread < 1.5,
        `ragged card widths across stack depths: ${widths.map(w => w.toFixed(1)).join(', ')}`);
});

test('thumbnails never collapse, and a wider sidebar yields bigger cards', () => {
    wsm.reset(1);
    // Worst case the settings allow: narrowest sidebar, widest angle, deepest
    // stack. Small is correct here; it is what fits.
    const worst = makeSidebar(makeSettings({ 'sidebar-width': 120, 'perspective-angle': 45 }));
    const [w, h] = worst._thumbSize(3);
    assert.ok(w >= 48, `thumbnail collapsed below the safety floor: ${w}px`);
    assert.ok(h > 0, 'non-positive height');

    // Size scales with the space available rather than being capped.
    const narrow = makeSidebar(makeSettings({ 'sidebar-width': 200, 'perspective-angle': 0 }));
    const roomy = makeSidebar(makeSettings({ 'sidebar-width': 400, 'perspective-angle': 0 }));
    assert.ok(roomy._thumbSize(1)[0] > narrow._thumbSize(1)[0] * 1.5,
        'a much wider sidebar should give much bigger thumbnails');
});

/* ═══ overflowing stages must be reachable by scrolling ══════════════ */

test('the sidebar is vertically scrollable when the cards overflow', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    sidebar._build();

    // St.PolicyType.NEVER === 2 means "this direction does not scroll", which
    // leaves the adjustment with no range at all.
    assert.notEqual(sidebar._scroll.vscrollbar_policy, 2,
        'vertical policy is NEVER; overflowing cards can never be reached');

    // Content taller than the viewport: a wheel event must move the adjustment.
    sidebar._scroll.setContentHeight(2000, 800);
    const adj = sidebar._scroll.vadjustment;
    assert.ok(adj.upper - adj.page_size > 0, 'no scrollable range');

    const wheelDown = { get_scroll_delta: () => [0, 1], get_scroll_direction: () => 1 };
    sidebar._scroll.emit('scroll-event', wheelDown);
    assert.ok(adj.value > 0, 'wheel down did not scroll the list');

    const at = adj.value;
    const wheelUp = { get_scroll_delta: () => [0, -1], get_scroll_direction: () => 0 };
    sidebar._scroll.emit('scroll-event', wheelUp);
    assert.ok(adj.value < at, 'wheel up did not scroll back');
});

test('scrolling clamps to the ends instead of running past them', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    sidebar._build();
    sidebar._scroll.setContentHeight(1000, 800);
    const adj = sidebar._scroll.vadjustment;
    // Without this the clamp assertions below are satisfied by 0 === 0 even when
    // scrolling is impossible.
    assert.ok(adj.upper - adj.page_size > 0, 'precondition: a real scrollable range');

    const down = { get_scroll_delta: () => [0, 1], get_scroll_direction: () => 1 };
    for (let i = 0; i < 40; i++) sidebar._scroll.emit('scroll-event', down);
    assert.equal(adj.value, adj.upper - adj.page_size, 'did not clamp at the bottom');

    const up = { get_scroll_delta: () => [0, -1], get_scroll_direction: () => 0 };
    for (let i = 0; i < 40; i++) sidebar._scroll.emit('scroll-event', up);
    assert.equal(adj.value, 0, 'did not clamp at the top');
});

test('scrolling works over the blank space between cards', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    sidebar._build();
    sidebar._scroll.setContentHeight(2000, 800);
    const adj = sidebar._scroll.vadjustment;

    // The gaps between cards belong to the column, not to any card. A wheel
    // event there used to stall the gesture.
    const down = { get_scroll_delta: () => [0, 1], get_scroll_direction: () => 1 };
    sidebar._box.emit('scroll-event', down);
    assert.ok(adj.value > 0, 'wheel over the gap between cards did not scroll');
});

test('only the card column is reactive; the panel around it stays click-through', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    sidebar._build();

    assert.equal(sidebar._panel.reactive, false,
        'a reactive panel swallows every click in its full-height column');
    assert.equal(sidebar._scroll.reactive, false, 'the scroll view must not be pickable');
    assert.equal(sidebar._box.reactive, true,
        'the card column must be pickable or the gaps stop scrolling');
});

test('scrolling works from a CARD, not just the scroll view', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const live = new FakeWindow('appA');
    const parked = new FakeWindow('appB', { minimized: true });
    ws0.adopt(live); ws0.adopt(parked);

    const sidebar = makeSidebar(makeSettings());
    sidebar._build();
    sidebar._initGroups();
    sidebar._scroll.setContentHeight(2000, 800);
    const adj = sidebar._scroll.vadjustment;

    // Build a real card and deliver the wheel to IT. The scroll view is not
    // reactive, so this is the path a real wheel event actually takes.
    const group = sidebar._groups.find(g => g.windows.has(parked));
    const card = sidebar._makeGroupCard(group);
    assert.ok(card, 'expected a card');

    const down = { get_scroll_delta: () => [0, 1], get_scroll_direction: () => 1 };
    card.emit('scroll-event', down);
    assert.ok(adj.value > 0,
        'a wheel event on a card did not scroll; the handler is only bound to the scroll view');
});

test('a legacy mouse reporting no delta still scrolls by direction', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    sidebar._build();
    sidebar._scroll.setContentHeight(2000, 800);
    const adj = sidebar._scroll.vadjustment;

    // Devices without smooth scrolling report a 0 delta and only a direction.
    const legacyDown = { get_scroll_delta: () => [0, 0], get_scroll_direction: () => 1 };
    sidebar._scroll.emit('scroll-event', legacyDown);
    assert.ok(adj.value > 0, 'discrete-direction fallback did not scroll');
});

test('a touchpad SMOOTH event scrolls by its delta', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    sidebar._build();
    sidebar._scroll.setContentHeight(2000, 800);
    const adj = sidebar._scroll.vadjustment;

    // SMOOTH is the only direction for which get_scroll_delta() is meaningful,
    // so the handler must read the delta on this branch and nowhere else.
    const smoothDown = {
        get_scroll_direction: () => Clutter.ScrollDirection.SMOOTH,
        get_scroll_delta: () => [0, 1],
    };
    const ret = sidebar._scroll.emit('scroll-event', smoothDown);

    assert.ok(adj.value > 0, 'a smooth-scroll delta did not move the adjustment');
    assert.equal(ret, Clutter.EVENT_STOP, 'a consumed scroll must stop propagating');
});

test('a gesture-end zero-delta SMOOTH event is not swallowed', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    sidebar._build();
    sidebar._scroll.setContentHeight(2000, 800);
    const adj = sidebar._scroll.vadjustment;

    const gestureEnd = {
        get_scroll_direction: () => Clutter.ScrollDirection.SMOOTH,
        get_scroll_delta: () => [0, 0],
    };
    const ret = sidebar._scroll.emit('scroll-event', gestureEnd);

    assert.equal(adj.value, 0, 'a zero-delta event must not move the adjustment');
    assert.equal(ret, Clutter.EVENT_PROPAGATE,
        'swallowing the gesture-end event stalls the next gesture');
});

/* ═══ dynamic: shape follows the window, size follows the display ═════ */

test('thumbnail shape follows the window it shows, not a fixed ratio', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const sidebar = makeSidebar(makeSettings());

    const landscape = new FakeWindow('wide', {
        actor: makeWindowActor({ size: [1600, 900] }),
    });
    const portrait = new FakeWindow('tall', {
        actor: makeWindowActor({ size: [700, 1000] }),
    });
    ws0.adopt(landscape); ws0.adopt(portrait);

    const wide = sidebar._makeStackedThumb([landscape]);
    const tall = sidebar._makeStackedThumb([portrait]);

    assert.equal(wide.width, tall.width, 'card width should stay uniform');
    assert.ok(tall.height > wide.height,
        `a portrait window should give a taller card (got ${tall.height} vs ${wide.height})`);

    // And the shape should actually match the window, not some average.
    const [w, h] = sidebar._thumbSize(1, sidebar._windowAspect(landscape));
    assert.ok(Math.abs(w / h - 1600 / 900) < 0.05, `shape drifted: ${w}x${h}`);
    // The clone must fill that box, not sit letterboxed inside it.
    const drawn = sidebar._makeWindowClone(landscape, w, h);
    assert.ok(Math.abs(drawn.width / w - 1) < 0.05 && Math.abs(drawn.height / h - 1) < 0.05,
        `window does not fill its card: ${drawn.width}x${drawn.height} in ${w}x${h}`);
});

test('an extreme window shape is clamped instead of producing an absurd card', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    const sliver = new FakeWindow('sliver', { frame: { x: 0, y: 0, width: 40, height: 1400 } });
    const ultrawide = new FakeWindow('ultra', { frame: { x: 0, y: 0, width: 5120, height: 720 } });

    const [, hSliver] = sidebar._thumbSize(1, sidebar._windowAspect(sliver));
    const [wUltra, hUltra] = sidebar._thumbSize(1, sidebar._windowAspect(ultrawide));
    assert.ok(hSliver / wUltra < 3, `sliver produced a ${hSliver}px tall card`);
    assert.ok(hUltra > 0 && wUltra / hUltra <= 2.4001, 'ultrawide not clamped');
});

test('an empty stage falls back to the display shape', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    // Stub monitor is 1920x1080 => 16:9.
    const [w, h] = sidebar._thumbSize(0);
    assert.ok(Math.abs(w / h - 1920 / 1080) < 0.05,
        `expected the monitor's 16:9 shape, got ${w}x${h}`);
});

test('HiDPI: user pixel settings and thumbnails share one unit, so cards still fit', () => {
    wsm.reset(1);
    for (const sf of [1, 2]) {
        const sidebar = makeSidebar(makeSettings({ 'sidebar-width': 220, 'perspective-angle': 22 }));
        sidebar._scaleFactor = sf;
        const panel = sidebar._PANEL_W;
        assert.equal(panel, 220 * sf, 'panel width must scale with the display');
        for (const layers of [1, 2, 3]) {
            const [tw] = sidebar._thumbSize(layers);
            const step = tw * (STACK_H / 170);
            const { projected } = cardWidth(panel, tw, layers, 22, step, sf);
            assert.ok(projected <= panel,
                `scale ${sf}x, ${layers} windows: card projects ${projected.toFixed(1)}px into ${panel}px`);
        }
        // And the card should occupy the same fraction of the sidebar at both scales.
        const frac = sidebar._thumbSize(1)[0] / panel;
        assert.ok(frac > 0.6 && frac < 0.95, `thumbnail/panel ratio off at ${sf}x: ${frac.toFixed(2)}`);
    }
});

test('the 3D rotation is applied to the card, not to the thumbnail inside it', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const sidebar = makeSidebar(makeSettings({ 'perspective-angle': 22 }));
    const card = new St.BoxLayout();
    const thumb = new St.Widget();
    card._thumb = thumb;
    sidebar._cards = [card];

    sidebar._animateCardsEntrance();
    assert.equal(card.rotation_angle_y, 22,
        'card is not rotated; the pill background would stay flat while its content tilts');
    assert.equal(thumb.rotation_angle_y, undefined,
        'thumbnail is still rotated independently of the pill that must contain it');
});

/* ═══ #19: an empty stage must not produce negative geometry ════════ */

test('#19 a stage with no windows still yields a sanely sized thumbnail', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    const [w, h] = sidebar._thumbSize(0);
    const thumb = sidebar._makeStackedThumb([]);
    assert.ok(thumb.width >= w && thumb.height >= h,
        `empty stack collapsed to ${thumb.width}x${thumb.height}, expected at least ${w}x${h}`);
    assert.ok(thumb.width > 0 && thumb.height > 0, 'non-positive size');
});

/* ═══ snapshots are a fallback for a dead actor, never the default ════ */

test('a swap renders no offscreen copies of the windows it parks', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);

    const actor = makeWindowActor();
    const parked = new FakeWindow('appA', { actor });
    const other = new FakeWindow('appB', { minimized: true, actor: makeWindowActor() });
    ws0.adopt(parked); ws0.adopt(other);

    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();

    const target = sidebar._groups.find(g => g.windows.has(other));
    sidebar._swapToGroup(target);
    // A full-size texture per window per click, ~8 MB at 1080p, that no card ever drew.
    assert.equal(actor.paintCount, 0, 'the swap painted a still nothing uses');
});

test('a parked window is cloned live from its actor', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    const actor = makeWindowActor();
    const w = new FakeWindow('appA', { actor, minimized: true });
    const inner = sidebar._makeWindowClone(w, 170, 110);
    assert.equal(inner.source, actor, 'expected a live clone of the window actor');
});

test('a window with no actor gets no clone, leaving the icon fallback', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    const w = new FakeWindow('appA');
    assert.equal(sidebar._makeWindowClone(w, 170, 110), null);
});

/* ═══ #4: stages past the cap are announced, not dropped silently ═══ */

test('#4 an overflow marker appears when more stages exist than fit', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);

    const sidebar = makeSidebar(makeSettings());
    sidebar._box = new St.BoxLayout();

    sidebar._addOverflowLabel(0);
    assert.equal(sidebar._box.get_children().length, 0, 'no marker when nothing is hidden');

    sidebar._addOverflowLabel(3);
    const marker = sidebar._box.get_children()[0];
    assert.ok(marker, 'expected an overflow marker');
    assert.equal(marker.text, '+3', 'marker should say how many stages are hidden');
});

/* ═══ struts: reserve space only when it can be coherent ═════════════ */

test('struts are claimed only while the sidebar is genuinely parked on screen', () => {
    wsm.reset(1);
    const settings = makeSettings({ 'sidebar-reserve-space': true, 'sidebar-auto-hide': false });
    const sidebar = makeSidebar(settings);
    sidebar._panel = fakeActor();
    sidebar._edge = fakeActor();
    let fs = false;
    sidebar._fullscreen = () => fs;

    assert.equal(sidebar._wantStruts(), false, 'must not reserve space while hidden');

    sidebar._show();
    sidebar._panel.finish();
    assert.equal(sidebar._wantStruts(), true, 'should reserve space once shown');

    fs = true;
    assert.equal(sidebar._wantStruts(), false, 'must give space back for a fullscreen window');
    fs = false;

    // Auto-hide and a reserved strut cannot coexist: the strut is derived from
    // geometry and would resize every window on each reveal.
    settings.set('sidebar-auto-hide', true);
    assert.equal(sidebar._wantStruts(), false, 'must not reserve space in auto-hide mode');

    settings.set('sidebar-auto-hide', false);
    settings.set('sidebar-reserve-space', false);
    assert.equal(sidebar._wantStruts(), false, 'must honour the setting being off');
});

test('the panel is only re-registered as chrome when its struts answer changes', () => {
    wsm.reset(1);
    const settings = makeSettings({ 'sidebar-reserve-space': true });
    const sidebar = makeSidebar(settings);
    sidebar._panel = fakeActor();
    sidebar._edge = fakeActor();
    sidebar._fullscreen = () => false;

    sidebar._applyChrome();
    assert.equal(sidebar._chromeAdded, true, 'chrome should be registered');
    assert.equal(sidebar._chromeStruts, false, 'no struts while hidden');

    const before = sidebar._chromeStruts;
    sidebar._applyChrome();
    assert.equal(sidebar._chromeStruts, before, 're-applying with no change must be a no-op');

    sidebar._show();
    sidebar._panel.finish();          // onComplete claims the struts
    assert.equal(sidebar._chromeStruts, true, 'struts claimed after the slide settles');

    sidebar._hide();
    assert.equal(sidebar._chromeStruts, false, 'struts released before sliding out');
});

/* ═══ #8: unmaximize must return to the origin workspace object ═════ */

test('#8 unmaximize returns the window to its origin workspace after reindexing', () => {
    const [ws0, ws1, ws2, ws3] = wsm.reset(4);
    const a = new FakeWindow('appA');
    const sibling = new FakeWindow('appS');
    const decoy = new FakeWindow('appD');
    ws2.adopt(a); ws2.adopt(sibling); ws3.adopt(decoy);
    wsm.setActive(ws2);

    const mtw = new MaximizeToWorkspace(makeSettings());
    mtw.enable();
    try {
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
        clock.advance(100);
        assert.equal(a.get_workspace(), ws0, 'precondition: moved to the empty ws0');

        // mutter reaps the still-empty ws1 → every later index shifts down one.
        wsm.removeWorkspace(ws1);

        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.UNMAXIMIZE);
        clock.advance(100);

        assert.equal(a.get_workspace()?.label, ws2.label,
            `unmaximize sent the window to ${a.get_workspace()?.label} instead of its origin ws2`);
    } finally { mtw.disable(); }
});

test('#8 unmaximize still returns the window when the feature is toggled off mid-flight', () => {
    const [ws0, ws1] = wsm.reset(2);
    const a = new FakeWindow('appA');
    const sibling = new FakeWindow('appS');
    ws1.adopt(a); ws1.adopt(sibling);
    wsm.setActive(ws1);

    const settings = makeSettings();
    const mtw = new MaximizeToWorkspace(settings);
    mtw.enable();
    try {
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
        clock.advance(100);
        assert.equal(a.get_workspace(), ws0, 'precondition: moved off ws1');

        settings.set('maximize-behavior', 'none');
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.UNMAXIMIZE);
        clock.advance(100);

        assert.equal(a.get_workspace()?.label, ws1.label,
            'window was stranded on the spawned workspace after the setting was turned off');
    } finally { mtw.disable(); }
});

test('#8 an edge-tiled (single-axis) window is left where it is', () => {
    const [ws0, ws1] = wsm.reset(2);
    // Snapped to the left half: horizontally NOT maximized, vertically yes.
    const a = new FakeWindow('appA', { maximizedH: false, maximizedV: true });
    const sibling = new FakeWindow('appS');
    ws1.adopt(a); ws1.adopt(sibling);
    wsm.setActive(ws1);

    const mtw = new MaximizeToWorkspace(makeSettings());
    mtw.enable();
    try {
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
        clock.advance(100);
        assert.equal(a.get_workspace()?.label, ws1.label,
            'tiling a window to half the screen must not move it to another workspace');
        assert.notEqual(a.get_workspace(), ws0);
    } finally { mtw.disable(); }
});

test('#8 a full maximize still moves, so the tiling guard is not just always-false', () => {
    const [ws0, ws1] = wsm.reset(2);
    const a = new FakeWindow('appA', { maximizedH: true, maximizedV: true });
    const sibling = new FakeWindow('appS');
    ws1.adopt(a); ws1.adopt(sibling);
    wsm.setActive(ws1);

    const mtw = new MaximizeToWorkspace(makeSettings());
    mtw.enable();
    try {
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
        clock.advance(100);
        assert.equal(a.get_workspace(), ws0, 'a full maximize must still move the window');
    } finally { mtw.disable(); }
});

test('maximize moves the window with the shell\'s own move, so it rides the switch animation', () => {
    const [ws0, ws1] = wsm.reset(2);
    const a = new FakeWindow('appA'); const sibling = new FakeWindow('appS');
    ws1.adopt(a); ws1.adopt(sibling);
    wsm.setActive(ws1);
    const mtw = new MaximizeToWorkspace(makeSettings({ 'maximize-behavior': 'workspace' }));
    mtw.enable();
    try {
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
        clock.advance(100);
        assert.deepEqual(Main.wm.moves, [[a, ws0]], 'the move must go through Main.wm.actionMoveWindow');
        assert.equal(wsm.get_active_workspace(), ws0, 'the user must follow the window');
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.UNMAXIMIZE);
        clock.advance(100);
        assert.equal(Main.wm.moves.length, 2, 'the way back must use it too');
        assert.equal(a.get_workspace(), ws1, 'unmaximize returns the window home');
        assert.equal(wsm.get_active_workspace(), ws1);
    } finally { mtw.disable(); }
});

test('maximize follows the target workspace object even if indices shift before the switch', () => {
    const [ws0, ws1, ws2, ws3] = wsm.reset(4);
    const d0 = new FakeWindow('appD0'); const d1 = new FakeWindow('appD1');
    const a = new FakeWindow('appA'); const sibling = new FakeWindow('appS');
    ws0.adopt(d0); ws1.adopt(d1); ws2.adopt(a); ws2.adopt(sibling);
    wsm.setActive(ws2);
    const mtw = new MaximizeToWorkspace(makeSettings({ 'maximize-behavior': 'workspace' }));
    mtw.enable();
    try {
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
        wsm.removeWorkspace(ws0);                 // d0 closed, ws0 reaped: ws3 is now index 2
        clock.advance(100);
        assert.equal(a.get_workspace(), ws3, 'window must land on the empty target ws3');
        assert.equal(wsm.get_active_workspace(), ws3,
            `switched to ${wsm.get_active_workspace()?.label} instead of the window's workspace`);
    } finally { mtw.disable(); }
});

test('a maximize undone before the deferred move leaves the window where it is', () => {
    const [ws0, ws1] = wsm.reset(2);
    const a = new FakeWindow('appA'); const sibling = new FakeWindow('appS');
    ws1.adopt(a); ws1.adopt(sibling);
    wsm.setActive(ws1);
    const mtw = new MaximizeToWorkspace(makeSettings({ 'maximize-behavior': 'workspace' }));
    mtw.enable();
    try {
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.UNMAXIMIZE);
        clock.advance(100);
        assert.equal(a.get_workspace(), ws1, 'a double-click flip must not bounce the window');
        assert.equal(wsm.get_active_workspace(), ws1, 'nor switch workspace');
        assert.equal(Main.wm.moves.length, 0);
    } finally { mtw.disable(); }
});

/* ═══ a rebuild must not strand the sidebar open ════════════════════ */

/** A sidebar with a REAL _refresh(), unlike makeSidebar()'s no-op stub. */
function realSidebar(settings) {
    const s = new StageSidebar(settings);
    s._build();
    s._visible = true;
    return s;
}

test('a refresh with the pointer away from the panel re-arms the hide timer', () => {
    wsm.reset(1);
    const sidebar = realSidebar(makeSettings({
        'sidebar-auto-hide': true,
        'show-on-empty-workspace': false,
    }));
    try {
        // Pointer far away from the 220px-wide left panel.
        setPointer(1500, 500);
        sidebar._hovered = true;          // as if a card had been hovered
        sidebar._refresh();

        assert.equal(sidebar._hovered, false,
            'hover must be re-derived from the pointer, not left true');
        assert.ok(sidebar._hideTimer,
            'a rebuild with the pointer away left nothing to hide the sidebar');
    } finally { sidebar.disable(); }
});

test('a refresh with the pointer still over the panel keeps it open', () => {
    wsm.reset(1);
    const sidebar = realSidebar(makeSettings({
        'sidebar-auto-hide': true,
        'show-on-empty-workspace': false,
    }));
    try {
        sidebar._box.set_size(180, 600);   // the cards, from the top of the column
        setPointer(40, 400);   // on them
        sidebar._refresh();

        assert.equal(sidebar._hovered, true,
            'pointer is over the panel, so hover must stay true');
        assert.equal(sidebar._hideTimer, null,
            'must not schedule a hide while the pointer is on the panel');
    } finally { sidebar.disable(); }
});

test('_pointerOverPanel uses the settled position, not the mid-slide one', () => {
    wsm.reset(1);
    const sidebar = realSidebar(makeSettings());
    try {
        // Panel parked off screen, as it is at the start of a reveal.
        sidebar._panel.set_position(-220, 32);
        sidebar._box.set_size(180, 600);
        setPointer(40, 400);
        assert.ok(sidebar._pointerOverPanel(),
            'a check made mid-slide must use where the panel is going, not where it is');
    } finally { sidebar.disable(); }
});

/* ═══ #9: disable() tears down every actor and signal source ════════ */

test('#9 disable() destroys every actor and disconnects every signal source', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    const destroyed = [];
    const mkActor = name => ({
        destroy() { destroyed.push(name); },
        hide() {}, show() {},
        remove_all_transitions() {}, set_position() {}, ease() {},
    });
    sidebar._panel = mkActor('panel');
    sidebar._edge = mkActor('edge');
    sidebar._box = mkActor('box');
    sidebar._scroll = mkActor('scroll');
    sidebar._safeDestroyContent = () => {};
    sidebar._removeKeybinding = () => {};

    // Stands in for a real signal source: disable() must call disconnectObject()
    // on it, passing the sidebar itself as the tracking object.
    const disconnectedWith = [];
    sidebar._sigSources.add({ disconnectObject(owner) { disconnectedWith.push(owner); } });

    sidebar.disable();

    assert.deepEqual(destroyed.sort(), ['box', 'edge', 'panel', 'scroll'],
        'teardown left a chrome actor on screen');
    assert.deepEqual(disconnectedWith, [sidebar],
        'disable() must call disconnectObject(this) on every tracked signal source');
    assert.equal(sidebar._sigSources.size, 0, 'signal sources must be cleared after disable()');
});

/* ═══ #12: timer bookkeeping must not untrack the wrong id ══════════ */

test('#12 a stale timer callback never untracks a different live timer', () => {
    wsm.reset(1);
    const mtw = new MaximizeToWorkspace(makeSettings());
    mtw._timers.push(9999);
    mtw._untrackTimer(4242);        // an id that was never tracked
    assert.deepEqual(mtw._timers, [9999],
        'splice(-1, 1) removed an unrelated live timer from tracking');
});

/* ═══ #18: the render fingerprint must not skip real changes ════════ */

test('#18 refresh is skipped when nothing changed, but not when a stage does', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA');
    const b = new FakeWindow('appB', { minimized: true });
    ws0.adopt(a); ws0.adopt(b);

    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();

    const first = sidebar._renderSignature();
    assert.equal(sidebar._renderSignature(), first, 'signature is not stable across calls');

    // Focus changes alone must not invalidate it (that was the churn source).
    a.activate();
    assert.equal(sidebar._renderSignature(), first,
        'focusing a window in the active stage changed the fingerprint');

    // A new parked stage must.
    const c = new FakeWindow('appC'); ws0.adopt(c);
    sidebar._onWindowMap(c);
    c.minimize(); deliver(sidebar, [c]);
    assert.notEqual(sidebar._renderSignature(), first,
        'a new parked stage did not change the fingerprint');
});

test('#18 resizing a card\'s window changes the fingerprint (its shape follows it)', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const live = new FakeWindow('appA');
    const parked = new FakeWindow('appB', {
        minimized: true, frame: { x: 0, y: 0, width: 1600, height: 900 },
    });
    ws0.adopt(live); ws0.adopt(parked);

    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    const before = sidebar._renderSignature();

    parked._frame = { x: 0, y: 0, width: 900, height: 1600 };   // rotated to portrait
    assert.notEqual(sidebar._renderSignature(), before,
        'card shape follows the window, so a reshape must invalidate the fingerprint');
});

/* ═══ all-windows mode: every window, every workspace, read-only ═════ */

/** A sidebar in all-windows mode with a real _box, ready to render. */
function allWindowsSidebar(overrides = {}) {
    const sidebar = makeSidebar(makeSettings({ 'sidebar-mode': 'all-windows', ...overrides }));
    sidebar._box = new St.BoxLayout();
    return sidebar;
}

test('all-windows shows windows from every workspace, not just the active one', () => {
    const [ws0, ws1, ws2] = wsm.reset(3);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA');
    const b = new FakeWindow('appB');
    const c = new FakeWindow('appC');
    ws0.adopt(a); ws1.adopt(b); ws2.adopt(c);

    const sidebar = allWindowsSidebar();
    sidebar._refreshAllWindows();

    assert.equal(sidebar._cards.length, 3,
        'expected one card per window across all three workspaces');
});

test('all-windows includes minimized windows, which is the point of the mode', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);
    const parked = new FakeWindow('appParked', { minimized: true });
    ws1.adopt(parked);

    const sidebar = allWindowsSidebar();
    sidebar._refreshAllWindows();

    assert.equal(sidebar._cards.length, 1,
        'a minimized window on another workspace must still get a card');
});

test('all-windows hides the focused window (already in front of you)', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const focused = new FakeWindow('appFocused');
    const other = new FakeWindow('appOther');
    ws0.adopt(focused); ws0.adopt(other);
    setFocus(focused);

    const sidebar = allWindowsSidebar();
    sidebar._refreshAllWindows();

    assert.equal(sidebar._cards.length, 1, 'only the non-focused window should get a card');
});

test('all-windows emits no header for a workspace with nothing to show', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);
    ws0.adopt(new FakeWindow('appA'));
    // ws1 deliberately left empty.

    const sidebar = allWindowsSidebar();
    sidebar._refreshAllWindows();

    const headers = sidebar._box.get_children()
        .filter(c => typeof c.text === 'string' && c.text.startsWith('Workspace'));
    assert.equal(headers.length, 1, 'an empty workspace must not leave a dangling header');
});

test('all-windows caps cards and reports the remainder', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    for (let i = 0; i < 12; i++) ws0.adopt(new FakeWindow(`app${i}`));

    const sidebar = allWindowsSidebar();
    sidebar._refreshAllWindows();

    assert.equal(sidebar._cards.length, 8, 'must not build a clone for every window');
    const overflow = sidebar._box.get_children().find(c => /^\+\d+$/.test(c.text ?? ''));
    assert.ok(overflow, 'expected an overflow marker');
    assert.equal(overflow.text, '+4', '12 windows minus the 8 drawn');
});

test('all-windows headers are not hover targets', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);
    ws0.adopt(new FakeWindow('appA'));
    ws1.adopt(new FakeWindow('appB'));

    const sidebar = allWindowsSidebar();
    sidebar._refreshAllWindows();

    // 2 headers + 2 cards in the column, but only the cards are bell-curve targets.
    assert.equal(sidebar._cards.length, 2, 'headers must never be pushed to _cards');
    assert.ok(sidebar._box.get_children().length > sidebar._cards.length,
        'headers should still be present in the column');
});

test('activating from all-windows never minimizes or regroups anything', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws0);
    const here = new FakeWindow('appHere');
    const there = new FakeWindow('appThere', { minimized: true });
    ws0.adopt(here); ws1.adopt(there);

    const sidebar = allWindowsSidebar();
    sidebar._initGroups();
    const groupsBefore = JSON.stringify(sidebar._groups.map(g => [...g.windows].map(w => w.get_id())));

    sidebar._activateWindow(there);

    assert.equal(there.minimized, false, 'the target window should be unminimized');
    assert.equal(there.activated, 1, 'the target window should be activated');
    assert.equal(here.minimized, false,
        'the outgoing window must NOT be minimized; all-windows is read-only');
    assert.equal(
        JSON.stringify(sidebar._groups.map(g => [...g.windows].map(w => w.get_id()))),
        groupsBefore,
        'stage membership must be untouched by an all-windows activation');
});

test('all-windows fingerprint follows the focused window', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA');
    const b = new FakeWindow('appB');
    ws0.adopt(a); ws0.adopt(b);

    const sidebar = allWindowsSidebar();
    setFocus(a);
    const withA = sidebar._renderSignature();
    setFocus(b);
    assert.notEqual(sidebar._renderSignature(), withA,
        'a focus change alters which cards are drawn, so it must invalidate the fingerprint');
});

/* ═══ toggle-sidebar keybinding behaviour ════════════════════════════ */

test('_toggleVisible flips the sidebar and respects the master switch', () => {
    wsm.reset(1);
    const settings = makeSettings();
    const sidebar = makeSidebar(settings);
    sidebar._build();

    let shown = 0, hidden = 0;
    sidebar._show = () => { shown++; sidebar._visible = true; };
    sidebar._hide = () => { hidden++; sidebar._visible = false; };

    sidebar._visible = false;
    sidebar._toggleVisible();
    assert.equal(shown, 1, 'toggle from hidden must show');

    sidebar._toggleVisible();
    assert.equal(hidden, 1, 'toggle from visible must hide');

    // Toggling is symmetric; a third press shows again, not a stuck state.
    sidebar._toggleVisible();
    assert.equal(shown, 2, 'toggle must keep alternating');
});

/* ═══ app merge/un-merge: grouping fold ═════════════════════════════ */

test('_groupByApp with an empty merge map behaves exactly as before, plus apps/key fields', () => {
    wsm.reset(1);
    const ws = wsm.get_workspace_by_index(0);
    const a = new FakeWindow('firefox'); ws.adopt(a);
    const b = new FakeWindow('files');   ws.adopt(b);

    const groups = _groupByApp(ws, null, new Map());
    assert.equal(groups.length, 2);
    for (const g of groups) {
        assert.equal(g.apps.length, 1, 'unmerged group should carry exactly one app');
        assert.equal(g.key, g.app.get_id(), 'unmerged group key should be its own app id');
    }
});

test('_groupByApp folds two apps sharing a merge-map entry into one group', () => {
    wsm.reset(1);
    const ws = wsm.get_workspace_by_index(0);
    const a = new FakeWindow('firefox'); ws.adopt(a);
    const b = new FakeWindow('files');   ws.adopt(b);

    const mergeMap = new Map([['files', 'firefox']]);
    const groups = _groupByApp(ws, null, mergeMap);

    assert.equal(groups.length, 1, 'firefox and files should fold into one group');
    const [g] = groups;
    assert.equal(g.key, 'firefox');
    assert.equal(g.apps.length, 2);
    assert.equal(g.windows.length, 2);
});

test('_groupByApp merge fold is transitive-safe: a merge chain still resolves to one flat group', () => {
    wsm.reset(1);
    const ws = wsm.get_workspace_by_index(0);
    const a = new FakeWindow('firefox'); ws.adopt(a);
    const b = new FakeWindow('files');   ws.adopt(b);
    const c = new FakeWindow('terminal'); ws.adopt(c);

    const mergeMap = new Map([['files', 'firefox'], ['terminal', 'firefox']]);
    const groups = _groupByApp(ws, null, mergeMap);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].apps.length, 3);
});

/* ═══ app merge/un-merge: persistence ═══════════════════════════════ */

test('app-merge-map round-trips through JSON exactly', () => {
    wsm.reset(1);
    const settings = makeSettings();
    const sidebar = makeSidebar(settings);
    sidebar._appMergeMap = new Map([['files', 'firefox'], ['terminal', 'firefox']]);
    sidebar._saveAppMergeMap();

    const sidebar2 = makeSidebar(settings);
    sidebar2._loadAppMergeMap();
    assert.equal(sidebar2._appMergeMap.get('files'), 'firefox');
    assert.equal(sidebar2._appMergeMap.get('terminal'), 'firefox');
});

test('malformed app-merge-map JSON falls back to an empty map, not a thrown error', () => {
    wsm.reset(1);
    const settings = makeSettings({ 'app-merge-map': 'not valid json {' });
    const sidebar = makeSidebar(settings);
    assert.doesNotThrow(() => sidebar._loadAppMergeMap());
    assert.equal(sidebar._appMergeMap.size, 0);
});

test('_mergeApp flattens a chain: merging onto an already-merged group keeps every entry one hop', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    sidebar._appMergeMap = new Map();
    sidebar._saveAppMergeMap = () => {}; // isolate from GSettings for this pure-logic check

    sidebar._mergeApp('files', 'firefox');
    sidebar._mergeApp('terminal', 'files'); // simulates dragging onto a group whose key later becomes 'files'
    assert.equal(sidebar._appMergeMap.get('files'), 'firefox');
    assert.equal(sidebar._appMergeMap.get('terminal'), 'files');
});

test('_unmergeGroup clears every member app from the merge map', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    sidebar._appMergeMap = new Map([['files', 'firefox'], ['terminal', 'firefox']]);
    sidebar._saveAppMergeMap = () => {};

    sidebar._unmergeGroup({ key: 'firefox', apps: [{ get_id: () => 'firefox' }, { get_id: () => 'files' }, { get_id: () => 'terminal' }] });
    assert.equal(sidebar._appMergeMap.size, 0);
});

/* ═══ app merge/un-merge: multi-icon rendering ══════════════════════ */

test('a merged app card shows one icon per member app', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'show-app-icons': true }));
    const appA = { get_id: () => 'firefox', create_icon_texture: s => { const i = new St.Widget(); i.set_size(s, s); return i; } };
    const appB = { get_id: () => 'files',   create_icon_texture: s => { const i = new St.Widget(); i.set_size(s, s); return i; } };
    const winA = new FakeWindow('firefox'); winA._ws = wsm.get_workspace_by_index(0);
    const winB = new FakeWindow('files');   winB._ws = wsm.get_workspace_by_index(0);

    const group = { key: 'firefox', app: appA, apps: [appA, appB], windows: [winA, winB] };
    const card = sidebar._makeAppCard(group);

    const iconBox = card.get_children().find(c => c !== card._thumb);
    assert.ok(iconBox, 'expected an icon row for a merged card');
    assert.equal(iconBox.get_children().length, 2, 'expected one icon per member app');
});

test('an unmerged app card still shows exactly one icon (no regression)', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'show-app-icons': true }));
    const appA = { get_id: () => 'firefox', create_icon_texture: s => { const i = new St.Widget(); i.set_size(s, s); return i; } };
    const winA = new FakeWindow('firefox'); winA._ws = wsm.get_workspace_by_index(0);

    const group = { key: 'firefox', app: appA, apps: [appA], windows: [winA] };
    const card = sidebar._makeAppCard(group);
    const iconBox = card.get_children().find(c => c !== card._thumb);
    assert.equal(iconBox.get_children().length, 1);
});

/* ═══ app merge/un-merge: drag gesture ══════════════════════════════ */

function fakeButtonEvent(button) { return { get_button: () => button }; }
function fakeMotionEvent(x, y) { return { get_coords: () => [x, y] }; }

test('a click with no movement still activates the app (no regression from drag wiring)', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'sidebar-mode': 'apps' }));
    const ws = wsm.get_workspace_by_index(0);
    const win = new FakeWindow('firefox'); ws.adopt(win);
    let activated = false;
    sidebar._activateApp = () => { activated = true; };

    const group = _groupByApp(ws, null, new Map())[0];
    const card = sidebar._makeAppCard(group);

    card.emit('button-press-event', fakeButtonEvent(1));
    card.emit('button-release-event', fakeButtonEvent(1));

    assert.ok(activated, 'a plain click (no drag movement) must still activate the app');
});

test('dragging one app card onto another commits a merge, and does not activate either', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'sidebar-mode': 'apps' }));
    sidebar._saveAppMergeMap = () => {}; // isolate from GSettings
    const ws = wsm.get_workspace_by_index(0);
    const winA = new FakeWindow('firefox'); ws.adopt(winA);
    const winB = new FakeWindow('files');   ws.adopt(winB);
    let activated = 0;
    sidebar._activateApp = () => { activated++; };

    const groups = _groupByApp(ws, null, new Map());
    const cardA = sidebar._makeAppCard(groups[0]);
    const cardB = sidebar._makeAppCard(groups[1]);

    cardA.emit('button-press-event', fakeButtonEvent(1));
    sidebar._onAppDragMotion(fakeMotionEvent(100, 100)); // well past the drag threshold
    // Clutter's implicit grab delivers release to the card that got the press
    // (cardA), never to whatever the pointer ends up over, so the drop
    // target has to be resolved by hit-testing the live pointer position,
    // which is what stage._actorAtPos stands in for here.
    stage._actorAtPos = cardB;
    cardA.emit('button-release-event', fakeButtonEvent(1));

    assert.equal(activated, 0, 'a committed drag must not also activate a card');
    assert.equal(sidebar._appMergeMap.size, 1, 'expected exactly one merge-map entry');
});

test('a multi-app drag commits with one settings write, not one per app in the source group', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'sidebar-mode': 'apps' }));
    let saves = 0;
    sidebar._saveAppMergeMap = () => { saves++; };
    const ws = wsm.get_workspace_by_index(0);
    const winA = new FakeWindow('firefox');  ws.adopt(winA);
    const winB = new FakeWindow('files');    ws.adopt(winB);
    const winC = new FakeWindow('terminal'); ws.adopt(winC);
    // firefox and files are already merged into one two-app source group.
    sidebar._appMergeMap = new Map([['files', 'firefox']]);

    const groups = _groupByApp(ws, null, sidebar._appMergeMap);
    const source = groups.find(g => g.key === 'firefox');
    const target = groups.find(g => g.key === 'terminal');
    assert.equal(source.apps.length, 2, 'test setup: source group should have 2 merged apps');

    sidebar._onDragCommit(source, target);

    // A per-app save (the pre-fix behaviour) would fire twice here, once per
    // app in the source group, each one a full settings write + sidebar
    // rebuild for what the user experienced as a single drag gesture.
    assert.equal(saves, 1, 'one drag gesture should trigger exactly one settings write, not one per merged app');
});

test('right-click on a merged card un-merges it', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'sidebar-mode': 'apps' }));
    sidebar._saveAppMergeMap = () => {};
    const ws = wsm.get_workspace_by_index(0);
    const winA = new FakeWindow('firefox'); ws.adopt(winA);
    const winB = new FakeWindow('files');   ws.adopt(winB);
    sidebar._appMergeMap = new Map([['files', 'firefox']]);

    const group = _groupByApp(ws, null, sidebar._appMergeMap)[0];
    assert.equal(group.apps.length, 2);
    const card = sidebar._makeAppCard(group);

    card.emit('button-press-event', fakeButtonEvent(3));
    assert.equal(sidebar._appMergeMap.size, 0, 'right-click should clear the merge');
});

test('starting a new drag cleans up a stale one that never received a release', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings({ 'sidebar-mode': 'apps' }));
    const ws = wsm.get_workspace_by_index(0);
    const win = new FakeWindow('firefox'); ws.adopt(win);
    const group = _groupByApp(ws, null, new Map())[0];
    const card = sidebar._makeAppCard(group);

    sidebar._startAppDragCandidate(group, card);
    assert.equal(stage.count, 1, 'expected exactly one motion-event handler after starting a drag');
    sidebar._startAppDragCandidate(group, card); // simulates a second press with no intervening release
    assert.equal(stage.count, 1, 'starting a new drag must not leak the previous motion-event handler');
});

/* ═══ report 2: Arc must be findable ════════════════════════════════ */

function arcFor(pos) {
    const arc = new ArcSidebar(makeSettings({ 'arc-panel-position': pos }));
    arc._scaleFactor = 1;
    arc._monitor = arc._pickMonitor();
    arc._loadMergeMap(); arc._loadOrderMap(); arc._loadConfig();
    return arc;
}

test('the Arc hover strip spans the whole work-area edge, not a 35% slice', () => {
    wsm.reset(1);
    const wa = Main.layoutManager.getWorkAreaForMonitor(0);
    for (const pos of ['left', 'right']) {
        const g = arcFor(pos)._geo;
        assert.equal(g.edgeY, wa.y, `${pos}: strip must start at the top of the work area`);
        assert.equal(g.edgeH, wa.height, `${pos}: strip must run the full work-area height`);
    }
    const b = arcFor('bottom')._geo;
    assert.equal(b.edgeX, wa.x);
    assert.equal(b.edgeW, wa.width, 'bottom: strip must run the full work-area width');
});

test('the Arc edge strip hides while Arc is open and returns when it closes', () => {
    wsm.reset(1);
    const arc = arcFor('left');
    arc._buildUI();
    try {
        assert.equal(arc._edge.visible, true, 'precondition: strip up while Arc is hidden');
        arc._showPanel();
        assert.equal(arc._edge.visible, false,
            'left up over the open carousel it stole the pointer at the edge and started a hide');
        arc._hidePanel();
        assert.equal(arc._edge.visible, true);
    } finally { arc._destroyUI(); }
});

test('the Arc edge strip does nothing during fullscreen', () => {
    wsm.reset(1);
    const arc = arcFor('left');
    arc._buildUI();
    const real = global.display.get_monitor_in_fullscreen;
    global.display.get_monitor_in_fullscreen = () => true;
    try {
        arc._syncEdge();
        assert.equal(arc._edge.visible, false, 'a 4px strip must not sit over fullscreen video');
        let shown = 0;
        arc._showPanel = () => { shown++; };
        arc._edge.emit('enter-event');
        clock.advance(2000);
        assert.equal(shown, 0, 'no reveal while fullscreen');
    } finally { global.display.get_monitor_in_fullscreen = real; arc._destroyUI(); }
});

test('Arc peeks on enable when asked, then hides by itself', () => {
    wsm.reset(1);
    const arc = new ArcSidebar(makeSettings(), { peek: true });
    arc.enable();
    try {
        assert.equal(arc._isVisible, true, 'a freshly selected Arc must slide in so users see it');
        clock.advance(3500);
        assert.equal(arc._isVisible, false, 'and step back out on its own');
    } finally { arc.disable(); }
});

test('Arc does not peek unless asked', () => {
    wsm.reset(1);
    const arc = new ArcSidebar(makeSettings());
    arc.enable();
    try { assert.equal(arc._isVisible, false); } finally { arc.disable(); }
});

test('Arc peeks once per login and on every explicit switch, not after each unlock', () => {
    wsm.reset(1);
    const settings = makeSettings({ 'sidebar-layout': 'arc' });
    const ext = new StageManagerExtension();
    ext._fakeSettings = settings;

    ext.enable();
    assert.equal(ext._side._peekOnEnable, true, 'first enable of the session peeks');
    ext.disable();

    ext.enable();                                // screen unlock re-enables
    assert.equal(ext._side._peekOnEnable, false, 'an unlock must not peek again');

    settings.set('sidebar-layout', 'stack');
    settings.set('sidebar-layout', 'arc');       // user picks Arc again
    assert.equal(ext._side._peekOnEnable, true, 'an explicit switch always peeks');
    ext.disable();
});

/* ═══ ArcSidebar: layout-swap wiring ═════════════════════════════════ */

test('sidebar-layout arc constructs ArcSidebar, not StageSidebar', () => {
    wsm.reset(1);
    const settings = makeSettings({ 'sidebar-layout': 'arc' });
    const ext = new StageManagerExtension();
    ext._fakeSettings = settings;
    ext.enable();
    assert.ok(ext._side instanceof ArcSidebar, 'expected ArcSidebar to be built for arc layout');
    ext.disable();
});

test('sidebar-layout stack constructs StageSidebar (unchanged default)', () => {
    wsm.reset(1);
    const settings = makeSettings({ 'sidebar-layout': 'stack' });
    const ext = new StageManagerExtension();
    ext._fakeSettings = settings;
    ext.enable();
    assert.ok(ext._side instanceof StageSidebar, 'expected StageSidebar to be built for stack layout');
    ext.disable();
});

test('changing sidebar-layout at runtime swaps the active controller', () => {
    wsm.reset(1);
    const settings = makeSettings({ 'sidebar-layout': 'stack' });
    const ext = new StageManagerExtension();
    ext._fakeSettings = settings;
    ext.enable();
    assert.ok(ext._side instanceof StageSidebar);
    settings.set_string('sidebar-layout', 'arc');
    assert.ok(ext._side instanceof ArcSidebar, 'expected swap to ArcSidebar on settings change');
    ext.disable();
});

/* ═══ ArcSidebar: _computeGeo() ═══════════════════════════════════════ */

test('_computeGeo left position: arc center sits off the left edge', () => {
    const settings = makeSettings({ 'arc-panel-position': 'left', 'arc-card-scale': 100 });
    const arc = new ArcSidebar(settings);
    arc._scaleFactor = 1;
    arc._monitor = Main.layoutManager.primaryMonitor;
    arc._loadConfig();
    const geo = arc._geo;
    assert.equal(geo.centerAngle, 0);
    assert.ok(geo.arcCX < 0, 'left-position arc center should be negative (off-screen left)');
});

test('_computeGeo right position: arc center sits off the right edge, angle 180', () => {
    const settings = makeSettings({ 'arc-panel-position': 'right' });
    const arc = new ArcSidebar(settings);
    arc._scaleFactor = 1;
    arc._monitor = Main.layoutManager.primaryMonitor;
    arc._loadConfig();
    assert.equal(arc._geo.centerAngle, 180);
});

test('_computeGeo bottom position: arc center below the workarea, angle -90', () => {
    const settings = makeSettings({ 'arc-panel-position': 'bottom' });
    const arc = new ArcSidebar(settings);
    arc._scaleFactor = 1;
    arc._monitor = Main.layoutManager.primaryMonitor;
    arc._loadConfig();
    assert.equal(arc._geo.centerAngle, -90);
});

test('_computeGeo radius scales with workarea height and floors at ARC_MIN_RADIUS * scaleFactor', () => {
    const settings = makeSettings({ 'arc-panel-position': 'left' });
    const arc = new ArcSidebar(settings);
    arc._scaleFactor = 2;
    arc._monitor = { x: 0, y: 0, width: 1920, height: 120, index: 0 };
    const origGetWA = Main.layoutManager.getWorkAreaForMonitor;
    Main.layoutManager.getWorkAreaForMonitor = () => ({ x: 0, y: 0, width: 1920, height: 40 });
    arc._loadConfig();
    assert.ok(arc._geo.arcR >= 200 * 2, `expected floor at 400, got ${arc._geo.arcR}`);
    Main.layoutManager.getWorkAreaForMonitor = origGetWA;
});

test('_computeGeo radius scales normally on a tall workarea (no floor triggered)', () => {
    const settings = makeSettings({ 'arc-panel-position': 'left' });
    const arc = new ArcSidebar(settings);
    arc._scaleFactor = 1;
    arc._monitor = { x: 0, y: 0, width: 1920, height: 1080, index: 0 };
    const origGetWA = Main.layoutManager.getWorkAreaForMonitor;
    Main.layoutManager.getWorkAreaForMonitor = () => ({ x: 0, y: 32, width: 1920, height: 1048 });
    arc._loadConfig();
    assert.equal(arc._geo.arcR, Math.round(1048 * 0.48));
    Main.layoutManager.getWorkAreaForMonitor = origGetWA;
});

/* ═══ ArcSidebar: data model: _buildGroups(), merge/order persistence ═ */

test('_buildGroups gives every window its own group when nothing is merged', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);
    const b = new FakeWindow('appB'); ws0.adopt(b);
    const arc = new ArcSidebar(makeSettings());
    arc._loadMergeMap(); arc._loadOrderMap();
    arc._buildGroups();
    assert.equal(arc._groups.length, 2);
    // Groups are keyed per WINDOW now, not per app, which is what makes
    // grouping two windows of the same app possible.
    assert.deepEqual(arc._groups.map(g => g.windowKeys.length), [1, 1]);
    assert.equal(new Set(arc._groups.map(g => g.key)).size, 2, 'keys must be distinct');
});

test('_buildGroups folds merged windows into one group carrying both', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);
    const b = new FakeWindow('appB'); ws0.adopt(b);
    const arc = new ArcSidebar(makeSettings());
    arc._loadMergeMap(); arc._loadOrderMap();
    arc._buildGroups();

    arc._mergeApps(arc._groups[1].windowKeys[0], arc._groups[0].windowKeys[0]);
    arc._buildGroups();

    assert.equal(arc._groups.length, 1);
    assert.equal(arc._groups[0].windowKeys.length, 2);
    assert.equal(arc._groups[0].windows.length, 2);
});

test('_buildGroups can group two windows of the SAME app, which app keys could not', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a1 = new FakeWindow('appA'); ws0.adopt(a1);
    const a2 = new FakeWindow('appA'); ws0.adopt(a2);
    const b = new FakeWindow('appB'); ws0.adopt(b);
    const arc = new ArcSidebar(makeSettings());
    arc._loadMergeMap(); arc._loadOrderMap();
    arc._buildGroups();
    assert.equal(arc._groups.length, 3,
        'two windows of one app must start as two separate groups');
});

test('_buildGroups sorts by order-map, unordered groups go last', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);
    const b = new FakeWindow('appB'); ws0.adopt(b);
    const c = new FakeWindow('appC'); ws0.adopt(c);
    const arc = new ArcSidebar(makeSettings());
    arc._loadMergeMap(); arc._loadOrderMap();
    arc._buildGroups();

    // Order is stored per group key, which is a window key now.
    const [k0, k1] = arc._groups.map(g => g.key);
    arc._orderMap.set(k1, 0);
    arc._orderMap.set(k0, 1);
    arc._buildGroups();

    assert.deepEqual(arc._groups.slice(0, 2).map(g => g.key), [k1, k0],
        'explicitly ordered groups come first, in their stored order');
});

test('_buildGroups promotes the focused window to the front of its group', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a1 = new FakeWindow('appA'); ws0.adopt(a1);
    const a2 = new FakeWindow('appA'); ws0.adopt(a2);
    const arc = new ArcSidebar(makeSettings());
    arc._loadMergeMap(); arc._loadOrderMap();
    arc._buildGroups();
    // Put both in one group, then focus the second.
    arc._mergeApps(arc._groups[1].windowKeys[0], arc._groups[0].windowKeys[0]);
    setFocus(a2);
    arc._buildGroups();

    assert.equal(arc._groups[0].windows[0], a2, 'focused window should be first');
});

test('_loadMergeMap falls back to an empty map on malformed JSON', () => {
    const arc = new ArcSidebar(makeSettings({ 'arc-merge-map': 'not json' }));
    arc._loadMergeMap();
    assert.equal(arc._mergeMap.size, 0);
});

test('_loadOrderMap falls back to an empty map on malformed JSON', () => {
    const arc = new ArcSidebar(makeSettings({ 'arc-order-map': '{ broken' }));
    arc._loadOrderMap();
    assert.equal(arc._orderMap.size, 0);
});

test('_mergeApps folds source into target and every member shares the new composite key', () => {
    const settings = makeSettings();
    const arc = new ArcSidebar(settings);
    arc._loadMergeMap();
    arc._mergeApps('appA', 'appB');
    assert.equal(arc._mergeMap.get('appA'), arc._mergeMap.get('appB'));
    assert.ok(arc._mergeMap.get('appA'), 'both members must share a composite key');
});

test('_mergeApps keeps one segment per app across repeated merges', () => {
    const settings = makeSettings();
    const arc = new ArcSidebar(settings);
    arc._loadMergeMap();

    arc._mergeApps('appB', 'appA');   // {A,B}
    arc._mergeApps('appC', 'appA');   // {A,B,C}
    arc._mergeApps('appD', 'appC');   // {A,B,C,D}

    const key = arc._mergeMap.get('appA');
    const segs = key.split('|');
    assert.deepEqual(segs, [...new Set(segs)],
        `merge key re-embeds itself and grows without bound: ${key}`);
    assert.deepEqual(segs.slice().sort(), ['appA', 'appB', 'appC', 'appD']);
    ['appA', 'appB', 'appC', 'appD'].forEach(a =>
        assert.equal(arc._mergeMap.get(a), key, `${a} should share the group key`));
});

test('_mergeApps key length stays bounded, not doubling per merge', () => {
    const arc = new ArcSidebar(makeSettings());
    arc._loadMergeMap();
    for (let i = 1; i <= 8; i++) arc._mergeApps(`app${i}`, 'appRoot');
    const key = arc._mergeMap.get('appRoot');
    assert.ok(key.split('|').length === 9,
        `expected 9 segments (root + 8), got ${key.split('|').length}; key is compounding`);
});

test('_loadMergeMap ignores whatever dconf holds, so stale keys cannot resurface', () => {
    // Group keys are per-session window numbers; reusing a stored map after a
    // login silently grouped unrelated windows that inherited those numbers.
    const stale = JSON.stringify({ w1: 'w1|w2', w2: 'w1|w2' });
    const arc = new ArcSidebar(makeSettings({ 'arc-merge-map': stale }));
    arc._loadMergeMap();
    assert.equal(arc._mergeMap.size, 0,
        'a persisted merge map must not be read back into a new session');
});

test('_loadOrderMap ignores dconf too, since it is keyed the same way', () => {
    const stale = JSON.stringify({ w1: 0, w2: 1 });
    const arc = new ArcSidebar(makeSettings({ 'arc-order-map': stale }));
    arc._loadOrderMap();
    assert.equal(arc._orderMap.size, 0);
});

test('merging never writes either map back to dconf', () => {
    const settings = makeSettings();
    const written = [];
    const realSet = settings.set_string;
    settings.set_string = (k, v) => { written.push(k); return realSet?.call(settings, k, v); };

    const arc = new ArcSidebar(settings);
    arc._loadMergeMap(); arc._loadOrderMap();
    arc._mergeApps('w2', 'w1');
    arc._orderMap.set('w1', 0);
    arc._saveOrderMap();

    assert.deepEqual(written.filter(k => k.startsWith('arc-')), [],
        `session-only maps must not touch dconf, but wrote: ${written.join(', ')}`);
});

test('_unmergeApp removes the app and cleans up now-singleton groups', () => {
    const settings = makeSettings();
    const arc = new ArcSidebar(settings);
    arc._loadMergeMap();
    arc._mergeApps('appA', 'appB');
    arc._unmergeApp('appA');
    assert.ok(!arc._mergeMap.has('appA'));
    assert.ok(!arc._mergeMap.has('appB'), 'the now-singleton former partner should also be cleaned up');
});

/* ═══ ArcSidebar: card rendering: grid, stack/fan offsets, icon row ═══ */

test('_positionStack lays cards at fixed fan-out offsets scaled by grid scale', () => {
    const arc = new ArcSidebar(makeSettings());
    const grid = new St.Widget({});
    grid._scale = 1;
    grid._cards = [
        { card: new St.Widget({}), dim: new St.Widget({}) },
        { card: new St.Widget({}), dim: new St.Widget({}) },
    ];
    arc._positionStack(grid, false);
    assert.equal(grid._cards[0].card.x, 0);
    assert.equal(grid._cards[0].card.y, 0);
    assert.ok(grid._cards[1].card.x > 0, 'second card should be offset horizontally');
    assert.equal(grid._fanned, false);
});

test('_positionFan spreads cards along the panel-position axis and returns the total shift', () => {
    const arc = new ArcSidebar(makeSettings({ 'arc-panel-position': 'left' }));
    arc._pos = 'left';
    const grid = new St.Widget({});
    grid._gridW = 100; grid._gridH = 80;
    grid._cards = [
        { card: new St.Widget({}), dim: new St.Widget({}), cW: 100, cH: 80 },
        { card: new St.Widget({}), dim: new St.Widget({}), cW: 100, cH: 80 },
    ];
    const { shift, isBottom } = arc._positionFan(grid);
    assert.equal(isBottom, false);
    assert.ok(shift > 0);
    assert.equal(grid._fanned, true);
});

test('_positionFan on a single-card grid is a no-op (no divide-by-zero / no shift)', () => {
    const arc = new ArcSidebar(makeSettings());
    const grid = new St.Widget({});
    grid._cards = [{ card: new St.Widget({}), dim: new St.Widget({}), cW: 100, cH: 80 }];
    const { shift } = arc._positionFan(grid);
    assert.equal(shift, 0);
});

test('_buildGrid builds one card per window (capped at 4), front card first in paint order via reversed add', () => {
    const win1 = new FakeWindow('appA', { actor: makeWindowActor() });
    const win2 = new FakeWindow('appA', { actor: makeWindowActor() });
    const group = { app: { get_id: () => 'appA' }, apps: [{ get_id: () => 'appA' }], windows: [win1, win2], appIds: ['appA'], key: 'appA' };
    const arc = new ArcSidebar(makeSettings());
    const grid = arc._buildGrid(group, 158, 89, 1);
    assert.equal(grid._cards.length, 2);
    assert.equal(grid._cards[0].win, win1);
});

test('_buildIconRow adds one icon widget per window in the group', () => {
    const win1 = new FakeWindow('appA', { actor: makeWindowActor() });
    const group = { app: { get_id: () => 'appA' }, apps: [], windows: [win1], appIds: ['appA'], key: 'appA' };
    const arc = new ArcSidebar(makeSettings());
    const grid = arc._buildGrid(group, 158, 89, 1);
    const container = new St.Widget({});
    arc._buildIconRow(container, group, 158, 42, 20, 12, 1, grid);
    assert.equal(container.children.length, 1);
});

/* ═══ ArcSidebar: _redraw() main render loop ══════════════════════════ */

test('_redraw creates one container per group, positioned along the arc', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA', { actor: makeWindowActor() }); ws0.adopt(a);
    const b = new FakeWindow('appB', { actor: makeWindowActor() }); ws0.adopt(b);
    const arc = new ArcSidebar(makeSettings());
    arc._scaleFactor = 1;
    arc._monitor = Main.layoutManager.primaryMonitor;
    arc._loadMergeMap(); arc._loadOrderMap(); arc._loadConfig();
    arc._panel = new St.Widget({});
    arc._buildGroups();
    arc._redraw();
    assert.equal(arc._containers.length, 2);
    assert.equal(arc._panel.children.length, 2);
});

test('_redraw skips a card once its angular offset exceeds ARC_MAX_ANGLE + angleStep', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    for (let i = 0; i < 10; i++) ws0.adopt(new FakeWindow(`app${i}`, { actor: makeWindowActor() }));
    const arc = new ArcSidebar(makeSettings({ 'arc-angle-step': 16 }));
    arc._scaleFactor = 1;
    arc._monitor = Main.layoutManager.primaryMonitor;
    arc._loadMergeMap(); arc._loadOrderMap(); arc._loadConfig();
    arc._panel = new St.Widget({});
    arc._offset = 0;
    arc._buildGroups();
    arc._redraw();
    assert.ok(arc._containers.length < 10, `expected some cards culled by MAX_ANGLE, got ${arc._containers.length}`);
});

test('_redraw clears previous containers and card timers before rebuilding', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    ws0.adopt(new FakeWindow('appA', { actor: makeWindowActor() }));
    const arc = new ArcSidebar(makeSettings());
    arc._scaleFactor = 1;
    arc._monitor = Main.layoutManager.primaryMonitor;
    arc._loadMergeMap(); arc._loadOrderMap(); arc._loadConfig();
    arc._panel = new St.Widget({});
    arc._buildGroups();
    arc._redraw();
    const firstContainer = arc._containers[0];
    arc._redraw();
    assert.ok(firstContainer.destroyed, 'first pass container should be destroyed on second redraw');
});

test('enable()/disable() cycle leaves zero pending card timers and zero tracked signal sources', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    ws0.adopt(new FakeWindow('appA', { actor: makeWindowActor() }));
    const arc = new ArcSidebar(makeSettings());
    arc.enable();
    clock.advance(50); // fire the debounced _scheduleRefresh timer
    arc.disable();
    assert.equal(arc._timers.length, 0, 'the tracked-timeout array must be drained by disable()');
    assert.equal(clock.pending, 0, 'no timers should remain pending after disable()');
});

/* ═══ ArcSidebar: drag: merge (outside) vs reorder (inside), un-merge ═ */

test('a press+release below the drag threshold is a plain click (activates the group)', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);
    const group = { app: a, apps: [], windows: [a], appIds: ['appA'], key: 'appA' };
    const arc = new ArcSidebar(makeSettings());
    arc._scaleFactor = 1;
    arc._activateGroup = (g) => { arc._activated = g; };
    const container = new St.Widget({});
    arc._onCardPress(container, group, { get_button: () => 1 });
    arc._onCardRelease(container, group, 0, { get_button: () => 1 });
    assert.equal(arc._activated, group);
    assert.equal(arc._drag, null);
});

test('dragging past the threshold and releasing outside the panel merges into the focused app', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const source = new FakeWindow('appSource'); ws0.adopt(source);
    const focused = new FakeWindow('appFocused'); ws0.adopt(focused);
    setFocus(focused);
    const sourceApp = { get_id: () => 'appSource', create_icon_texture: () => new St.Widget({}) };
    const srcKey = arc0WindowKey(source);
    const group = {
        app: sourceApp, apps: [sourceApp], windows: [source],
        appIds: ['appSource'], windowKeys: [srcKey], key: srcKey,
    };
    const arc = new ArcSidebar(makeSettings());
    arc._scaleFactor = 1;
    arc._geo = { visX: 0, visY: 0, panelW: 200, panelH: 800 };
    arc._loadMergeMap();
    const container = new St.Widget({});
    // Press captures its start position from global.get_pointer() (stub default [0,0]);
    // only override it for the release read, or the drag's start would move too and
    // the motion delta would cancel out to zero.
    arc._onCardPress(container, group, { get_button: () => 1 });
    arc._onDragMotion({ get_coords: () => [9999, 9999] });
    const origGetPointer = global.get_pointer;
    global.get_pointer = () => [9999, 9999]; // release point, outside the panel rect
    try {
        arc._onCardRelease(container, group, 0, { get_button: () => 1 });
    } finally { global.get_pointer = origGetPointer; }
    const focusedKey = arc0WindowKey(focused);
    assert.ok(arc._mergeMap.get(srcKey), 'expected a merge-map entry for the dragged window');
    assert.equal(arc._mergeMap.get(srcKey), arc._mergeMap.get(focusedKey));
    assert.equal(arc._drag, null);
});

test('dragging past the threshold and releasing inside the panel reorders instead of merging', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);
    const b = new FakeWindow('appB'); ws0.adopt(b);
    const appAObj = { get_id: () => 'appA', create_icon_texture: () => new St.Widget({}) };
    const appBObj = { get_id: () => 'appB', create_icon_texture: () => new St.Widget({}) };
    const groupA = { app: appAObj, apps: [appAObj], windows: [a], appIds: ['appA'], key: 'appA' };
    const groupB = { app: appBObj, apps: [appBObj], windows: [b], appIds: ['appB'], key: 'appB' };
    const arc = new ArcSidebar(makeSettings());
    arc._scaleFactor = 1;
    arc._geo = { visX: 0, visY: 0, panelW: 200, panelH: 800 };
    arc._loadMergeMap(); arc._loadOrderMap();
    arc._groups = [groupA, groupB];
    const containerA = new St.Widget({}); containerA.set_position(0, 0); containerA.set_size(100, 80);
    const containerB = new St.Widget({}); containerB.set_position(0, 200); containerB.set_size(100, 80);
    arc._containers = [containerA, containerB];
    arc._containerByKey = new Map([['appA', containerA], ['appB', containerB]]);
    arc._panel = new St.Widget({});   // at the stage origin, so panel and stage coords agree
    arc._onCardPress(containerA, groupA, { get_button: () => 1 });
    arc._onDragMotion({ get_coords: () => [50, 240] });
    const origGetPointer = global.get_pointer;
    global.get_pointer = () => [50, 240]; // release point, inside the panel, near containerB
    try {
        arc._onCardRelease(containerA, groupA, 0, { get_button: () => 1 });
    } finally { global.get_pointer = origGetPointer; }
    assert.equal(arc._orderMap.get('appA'), 1, 'appA should be reordered to appB\'s slot');
    assert.equal(arc._mergeMap.size, 0, 'a reorder must not also create a merge-map entry');
});

test('right-click on a merged (multi-app) card un-merges every member app', () => {
    const settings = makeSettings();
    const arc = new ArcSidebar(settings);
    arc._loadMergeMap();
    arc._mergeApps('w1', 'w2');
    const group = {
        apps: [{ get_id: () => 'appA' }, { get_id: () => 'appB' }],
        appIds: ['appA', 'appB'], windowKeys: ['w1', 'w2'],
    };
    const container = new St.Widget({});
    const stop = arc._onCardPress(container, group, { get_button: () => 3 });
    assert.equal(stop, Clutter.EVENT_STOP);
    assert.equal(arc._mergeMap.size, 0);
});

test('right-click on a single-app card is not consumed (propagates for a normal click)', () => {
    const arc = new ArcSidebar(makeSettings());
    const group = { apps: [{ get_id: () => 'appA' }], appIds: ['appA'], windowKeys: ['w1'] };
    const container = new St.Widget({});
    const result = arc._onCardPress(container, group, { get_button: () => 3 });
    assert.equal(result, Clutter.EVENT_PROPAGATE);
});

test('_cancelDrag disconnects the stage motion-event listener and clears drag state', () => {
    const arc = new ArcSidebar(makeSettings());
    arc._scaleFactor = 1;
    const group = { app: {}, apps: [], windows: [], appIds: ['appA'], key: 'appA' };
    const container = new St.Widget({});
    arc._onCardPress(container, group, { get_button: () => 1 });
    assert.ok(arc._drag, 'expected a drag candidate after press');
    arc._cancelDrag();
    assert.equal(arc._drag, null);
    assert.equal(stage._tracked?.get(arc)?.length ?? 0, 0, 'stage motion-event should be disconnected');
});

/* ═══ ArcSidebar: momentum scroll, show/hide, persistent mode ════════ */

test('scrolling accumulates velocity and starts the physics timer, which decays toward zero', () => {
    const arc = new ArcSidebar(makeSettings({ 'arc-scroll-speed': 10 }));
    arc._scaleFactor = 1;
    arc._monitor = Main.layoutManager.primaryMonitor;
    arc._loadConfig();
    arc._groups = [{}, {}, {}];
    arc._redraw = () => {};
    arc._handleScroll({ get_scroll_direction: () => Clutter.ScrollDirection.DOWN });
    assert.ok(arc._physicsTimer, 'expected physics timer to start');
    clock.advance(16);
    assert.ok(arc._offset > 0, 'offset should have moved after one physics tick');
});

test('_scrollTo eases offset to a target index and calls onComplete on arrival', () => {
    const arc = new ArcSidebar(makeSettings());
    arc._groups = [{}, {}, {}];
    arc._redraw = () => {};
    let completed = false;
    arc._scrollTo(2, () => { completed = true; });
    for (let i = 0; i < 50 && !completed; i++) clock.advance(16);
    assert.ok(completed, 'onComplete should fire once the eased scroll reaches its target');
    assert.equal(Math.round(arc._offset), 2);
});

test('leaving the panel starts the hide timer, which hides after auto-hide-delay', () => {
    const arc = new ArcSidebar(makeSettings({ 'auto-hide-delay': 800 }));
    arc._hideDelay = 800;
    arc._geo = { visX: 100, visY: 0, hidX: -200, hidY: 0, panelW: 200, panelH: 800 };
    arc._panel = new St.Widget({});
    arc._isVisible = true;
    arc._startHide();
    assert.ok(arc._hideTimer);
    clock.advance(800);
    assert.equal(arc._isVisible, false);
});

test('persistent mode auto-shows when no window overlaps the panel, hides again when one does', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const settings = makeSettings({ 'arc-persistent-mode': true });
    const arc = new ArcSidebar(settings);
    arc._persistEnabled = true;
    arc._geo = { visX: 0, visY: 0, panelW: 200, panelH: 800 };
    arc._panel = new St.Widget({});
    arc._scheduleRefresh = () => {};
    arc._checkPersistence();
    assert.equal(arc._isVisible, true, 'no windows overlap -> should auto-show');

    const overlapping = new FakeWindow('appA', { frame: { x: 0, y: 0, width: 100, height: 100 } });
    ws0.adopt(overlapping);
    arc._checkPersistence();
    assert.equal(arc._isVisible, false, 'an overlapping window should auto-hide again');
});

/* ═══ ArcSidebar: keybindings ══════════════════════════════════════── */

test('_addKeybindings binds the shared toggle plus all four arc-specific keys when non-empty', () => {
    const settings = makeSettings({
        'toggle-sidebar': ['<Super>a'],
        'keybinding-arc-next': ['<Super>Right'],
    });
    let bound = [];
    const origAdd = Main.wm.addKeybinding;
    Main.wm.addKeybinding = (name) => { bound.push(name); return 1; };
    const arc = new ArcSidebar(settings);
    arc._addKeybindings();
    Main.wm.addKeybinding = origAdd;
    assert.ok(bound.includes('toggle-sidebar'));
    assert.ok(bound.includes('keybinding-arc-next'));
    assert.ok(!bound.includes('keybinding-arc-prev'), 'empty binding should not be registered');
});

test('_removeKeybindings only removes keys that were actually bound', () => {
    const settings = makeSettings({ 'toggle-sidebar': ['<Super>a'] });
    let removed = [];
    const origAdd = Main.wm.addKeybinding;
    const origRemove = Main.wm.removeKeybinding;
    Main.wm.addKeybinding = () => 1;
    Main.wm.removeKeybinding = (name) => removed.push(name);
    const arc = new ArcSidebar(settings);
    arc._addKeybindings();
    arc._removeKeybindings();
    Main.wm.addKeybinding = origAdd;
    Main.wm.removeKeybinding = origRemove;
    assert.ok(removed.includes('toggle-sidebar'));
    assert.ok(!removed.includes('keybinding-arc-prev'), 'never-bound key should not be removed');
});

test('keybinding-arc-next callback advances toward the next card', () => {
    const settings = makeSettings({ 'keybinding-arc-next': ['<Super>Right'] });
    let callback = null;
    const origAdd = Main.wm.addKeybinding;
    Main.wm.addKeybinding = (name, _s, _f, _m, cb) => { if (name === 'keybinding-arc-next') callback = cb; return 1; };
    const arc = new ArcSidebar(settings);
    arc._groups = [{}, {}, {}];
    arc._offset = 0;
    let scrolledTo = null;
    arc._scrollTo = (idx) => { scrolledTo = idx; };
    arc._addKeybindings();
    Main.wm.addKeybinding = origAdd;
    callback();
    assert.equal(scrolledTo, 1);
});

test('_toggleVisible shows when hidden and hides when visible', () => {
    const arc = new ArcSidebar(makeSettings());
    arc._isVisible = false;
    let shown = false, hidden = false;
    arc._showPanel = () => { shown = true; };
    arc._hidePanel = () => { hidden = true; };
    arc._toggleVisible();
    assert.ok(shown);
    arc._isVisible = true;
    arc._toggleVisible();
    assert.ok(hidden);
});

/* ═══ ArcSidebar: _panel must not clip distant-but-visible cards ═════ */

test('_panel is not clip_to_allocation; cards beyond relIdx=1 legitimately extend past the nominal one-card-wide panel box', () => {
    // On a real 1920x1080 monitor at scale 1 with default settings, arcR
    // (~503px, derived from workarea height) is more than double panelW
    // (~201px, sized for one card); a card's x drifts by arcR*(1-cos(angle))
    // as it moves off-center, which already exceeds panelW by relIdx=2-3,
    // well before the angle-based MAX_ANGLE cull would hide it. If the panel
    // clips its own allocation, those still-visible-per-the-cull cards render
    // as partial slivers or vanish entirely, which is what actually happened
    // on a real monitor (see conversation), not a hypothetical.
    const arc = new ArcSidebar(makeSettings());
    arc._scaleFactor = 1;
    arc._monitor = Main.layoutManager.primaryMonitor;
    arc._loadMergeMap(); arc._loadOrderMap(); arc._loadConfig();
    arc._buildUI();
    assert.equal(arc._panel.clip_to_allocation, false,
        'clipping the panel to a one-card-wide box hides cards the angle cull already decided to show');
    arc._destroyUI();
});

/* ═══ report 3: a window under the sidebar must stay clickable ══════ */

/** A maximized-like window: covers the whole left strip below the top bar. */
const coveringFrame = () => ({ x: 0, y: 32, width: 1920, height: 1048 });
const clearFrame = () => ({ x: 600, y: 200, width: 600, height: 400 });

test('a window over the sidebar area counts as covering it; one beside it does not', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const w = new FakeWindow('appA', { frame: coveringFrame() }); ws0.adopt(w);
    const sidebar = realSidebar(makeSettings());
    try {
        assert.equal(sidebar._windowCoversPanel(), true);
        w._frame = clearFrame();
        assert.equal(sidebar._windowCoversPanel(), false);
        w._frame = coveringFrame(); w.minimized = true;
        assert.equal(sidebar._windowCoversPanel(), false, 'a minimized window covers nothing');
    } finally { sidebar.disable(); }
});

test('an always-visible sidebar steps aside while a window covers it, and returns when it clears', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const w = new FakeWindow('appA', { frame: coveringFrame() }); ws0.adopt(w);
    const sidebar = realSidebar(makeSettings({ 'sidebar-auto-hide': false }));
    try {
        setPointer(1500, 500);
        sidebar._syncCovered();
        clock.advance(1000);
        assert.equal(sidebar._visible, false,
            'with a maximized window under it the sidebar must slide out, or it blocks that window');

        w._frame = clearFrame();
        sidebar._syncCovered();
        assert.equal(sidebar._visible, true, 'once the area is clear it must come back on its own');
    } finally { sidebar.disable(); }
});

test('hide-when-covered never applies while space is reserved for the sidebar', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const w = new FakeWindow('appA', { frame: coveringFrame() }); ws0.adopt(w);
    const sidebar = realSidebar(makeSettings({ 'sidebar-reserve-space': true }));
    try {
        setPointer(1500, 500);
        sidebar._syncCovered();
        clock.advance(1000);
        assert.equal(sidebar._visible, true,
            'releasing the strut would let windows grow back under the sidebar for good');
    } finally { sidebar.disable(); }
});

test('hide-when-covered can be switched off', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const w = new FakeWindow('appA', { frame: coveringFrame() }); ws0.adopt(w);
    const sidebar = realSidebar(makeSettings({ 'sidebar-hide-when-covered': false }));
    try {
        setPointer(1500, 500);
        sidebar._syncCovered();
        clock.advance(1000);
        assert.equal(sidebar._visible, true);
    } finally { sidebar.disable(); }
});

test('an edge reveal stays while the pointer rests on the sidebar area and recedes once it leaves', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const w = new FakeWindow('appA', { frame: coveringFrame() }); ws0.adopt(w);
    const sidebar = realSidebar(makeSettings({ 'sidebar-auto-hide': false }));
    sidebar._visible = false;
    try {
        setPointer(2, 400);              // still on the edge strip after the dwell
        sidebar._revealFromEdge();
        clock.advance(3000);
        assert.equal(sidebar._visible, true, 'must not hide from under a pointer still on it');

        setPointer(1500, 400);           // moved away without touching a card
        clock.advance(1000);
        assert.equal(sidebar._visible, false,
            'the panel is click-through, so no leave-event comes: the timer itself must notice');
    } finally { sidebar.disable(); }
});

test('a burst of window signals runs the coverage check once', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const w = new FakeWindow('appA', { frame: coveringFrame() }); ws0.adopt(w);
    const sidebar = realSidebar(makeSettings());
    let checks = 0;
    sidebar._syncCovered = () => { checks++; };
    sidebar._wire();
    try {
        windowManager.emit('size-change', { meta_window: w }, Meta.SizeChange.MAXIMIZE);
        windowManager.emit('map', { meta_window: w });
        display.emit('grab-op-end', w, 0);
        clock.advance(500);
        assert.equal(checks, 1, `expected one debounced check, got ${checks}`);
    } finally { sidebar.disable(); }
});

/* ═══ report 1: clicking the wallpaper parks the current stage ═══════ */

function stageOfTwo(over = {}) {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA', { frame: clearFrame() });
    const b = new FakeWindow('appB', { frame: clearFrame() });
    ws0.adopt(a); ws0.adopt(b);
    const sidebar = new StageSidebar(makeSettings({ 'sidebar-auto-hide': false, ...over }));
    sidebar._build(); sidebar._wire(); sidebar._initGroups();
    return { sidebar, a, b };
}
const wallpaperPress = (button = 1) =>
    ({ get_button: () => button, _source: new Meta.BackgroundActor() });

test('clicking the bare wallpaper parks the current stage as ONE card', () => {
    const { sidebar, a, b } = stageOfTwo();
    try {
        stage.emit('button-press-event', wallpaperPress());
        assert.ok(a.minimized && b.minimized, 'the stage\'s windows must be parked');
        const parked = sidebar._getInactiveGroups();
        assert.equal(parked.length, 1, 'parked as one stage, not split per window');
        assert.equal(parked[0].windows.size, 2);
    } finally { sidebar.disable(); }
});

test('a wallpaper click is ignored for right-click, other actors, the overview and menus', () => {
    for (const [label, press, mode] of [
        ['right-click', wallpaperPress(3), Shell.ActionMode.NORMAL],
        ['press on a shell actor', { get_button: () => 1, _source: new St.Widget() }, Shell.ActionMode.NORMAL],
        ['overview open', wallpaperPress(), Shell.ActionMode.OVERVIEW],
        ['menu open', wallpaperPress(), Shell.ActionMode.POPUP],
    ]) {
        const { sidebar, a, b } = stageOfTwo();
        Main.actionMode = mode;
        try {
            stage.emit('button-press-event', press);
            assert.ok(!a.minimized && !b.minimized, `${label} must not park the stage`);
        } finally { sidebar.disable(); Main.actionMode = Shell.ActionMode.NORMAL; }
    }
});

const pressEvent = (button = 1) => ({ type: () => Clutter.EventType.BUTTON_PRESS, get_button: () => button });

const BUTTON1 = Clutter.ModifierType.BUTTON1_MASK;

/** A primary press on the DING desktop: focus moves to it while the press dispatches. */
function pressDesktop(x = 500, y = 500) {
    setPointer(x, y, 0);             // the button mask is not set yet while the press dispatches
    setCurrentEvent(pressEvent());
    setFocus(new FakeWindow('ding', { type: Meta.WindowType.DESKTOP }));
    display.emit('notify::focus-window');
    setCurrentEvent(null);
}

test('clicking Ubuntu desktop icons (a DESKTOP window taking focus) parks the stage', () => {
    const { sidebar, a, b } = stageOfTwo();
    try {
        pressDesktop();
        setPointer(500, 500, BUTTON1);   // still held
        clock.advance(200);
        assert.ok(!a.minimized && !b.minimized, 'nothing may park before the button comes up');
        setPointer(500, 500, 0);         // released where it was pressed: a click
        clock.advance(60);
        assert.ok(a.minimized && b.minimized,
            'DING takes the click itself, so the focus change is the only signal');
    } finally { sidebar.disable(); }
});

test('dragging a file from the desktop onto a window does not park that window', () => {
    const { sidebar, a, b } = stageOfTwo();
    try {
        pressDesktop(500, 500);
        setPointer(560, 520, BUTTON1);   // dragging the icon away
        clock.advance(60);
        setPointer(900, 400, 0);         // dropped on the app window
        clock.advance(200);
        assert.ok(!a.minimized && !b.minimized, 'the drop target was minimized under the pointer');
        assert.equal(sidebar._deskTimer, null, 'the release check must stop once it is a drag');
    } finally { sidebar.disable(); }
});

test('a click on a desktop that already has focus (after an icon drag) still parks', () => {
    const { sidebar, a, b } = stageOfTwo();
    const desk = () => display.get_focus_window();
    try {
        pressDesktop(500, 500);
        setPointer(900, 400, 0);         // dragged onto the app and dropped
        clock.advance(200);
        assert.ok(!a.minimized && !b.minimized, 'precondition: the drag parked nothing');
        setPointer(500, 500, 0);
        setCurrentEvent(pressEvent());
        desk().raise();                  // focus is unchanged, so only the raise is seen
        setCurrentEvent(null);
        clock.advance(60);
        assert.ok(a.minimized && b.minimized, 'the next desktop click did nothing');
        const d = desk();
        d.unmanage();
        assert.equal(d.signalCount, 0, 'a closed desktop window keeps our handlers');
        assert.ok(!sidebar._sigSources.has(d), 'a closed desktop window stays referenced');
    } finally { sidebar.disable(); }
});

test('a window that becomes the desktop after joining a stage (DING) never shows as a card', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const ding = new FakeWindow('ding', { frame: clearFrame() });   // NORMAL until its title arrives
    const b = new FakeWindow('appB', { frame: clearFrame() });
    ws0.adopt(ding); ws0.adopt(b);
    const sidebar = new StageSidebar(makeSettings({ 'sidebar-auto-hide': false }));
    sidebar._build(); sidebar._wire(); sidebar._initGroups();
    try {
        assert.ok(sidebar._findGroupForWindow(ding), 'precondition: it joined while still normal');
        ding._type = Meta.WindowType.DESKTOP;       // DING's title parsed: no stacking change
        sidebar._showDesktop();
        const [parked] = sidebar._getInactiveGroups();
        assert.deepEqual(sidebar._groupWindows(parked), [b], 'the desktop rode along in the card');
        b.unmanage();                               // the last app window closes
        display.emit('restacked');
        clock.advance(200);
        assert.equal(sidebar._getInactiveGroups().length, 0,
            'with no window open, a card for the desktop window remained');
        sidebar._showDesktop();
        assert.equal(sidebar._getInactiveGroups().length, 0, 'parking the bare desktop made a card');
    } finally { sidebar.disable(); }
});

test('disable() disconnects the desktop window it watched', () => {
    const { sidebar } = stageOfTwo();
    pressDesktop();
    const d = display.get_focus_window();
    assert.equal(d.signalCount, 2, 'precondition: raised + unmanaged');
    sidebar.disable();
    assert.equal(d.signalCount, 0);
});

test('a desktop press that ends with focus elsewhere does not park', () => {
    const { sidebar, a, b } = stageOfTwo();
    try {
        pressDesktop();
        setFocus(a);                      // e.g. the click opened a file in a
        clock.advance(60);
        assert.ok(!a.minimized && !b.minimized);
    } finally { sidebar.disable(); }
});

test('disable() drops a pending desktop-click check', () => {
    const { sidebar } = stageOfTwo();
    pressDesktop();
    setPointer(500, 500, BUTTON1);
    assert.ok(sidebar._deskTimer, 'precondition: waiting for the release');
    sidebar.disable();
    assert.equal(sidebar._deskTimer, null);
    assert.equal(sidebar._timers.length, 0);
});

test('the desktop window gaining focus without a click, or by right-click, does not park', () => {
    for (const [label, ev] of [['no click (programmatic)', null], ['right-click', pressEvent(3)]]) {
        const { sidebar, a, b } = stageOfTwo();
        try {
            setCurrentEvent(ev);
            setFocus(new FakeWindow('ding', { type: Meta.WindowType.DESKTOP }));
            display.emit('notify::focus-window');
            assert.ok(!a.minimized && !b.minimized, `${label} must not park`);
        } finally { sidebar.disable(); }
    }
});

test('desktop-click parking is groups-only and can be switched off', () => {
    for (const over of [{ 'sidebar-mode': 'apps' }, { 'park-on-desktop-click': false }]) {
        const { sidebar, a, b } = stageOfTwo(over);
        try {
            stage.emit('button-press-event', wallpaperPress());
            assert.ok(!a.minimized && !b.minimized, `must not park with ${JSON.stringify(over)}`);
        } finally { sidebar.disable(); }
    }
});

test('the wallpaper handler sits on the stage, not on window_group', () => {
    const { sidebar } = stageOfTwo();
    try {
        // Clutter only bubbles events to REACTIVE actors and the stage, and
        // window_group is not reactive: a handler there never fires in a real
        // shell (verified in a nested shell; this stub cannot model picking).
        assert.equal(windowGroup.count, 0, 'nothing may rely on window_group receiving presses');
        assert.ok(stage.count > 0, 'the stage must carry the wallpaper handler');
    } finally { sidebar.disable(); }
});

test('ending a card drag does not unhook the wallpaper handler', () => {
    const { sidebar, a, b } = stageOfTwo();
    try {
        // _cancelAppDrag() drops every stage handler owned by the sidebar itself.
        sidebar._startAppDragCandidate({ key: 'x', apps: [], windows: [a] }, null);
        sidebar._cancelAppDrag();
        stage.emit('button-press-event', wallpaperPress());
        assert.ok(a.minimized && b.minimized, 'a finished drag silently disabled desktop-click parking');
    } finally { sidebar.disable(); }
});

test('disable() disconnects the wallpaper click handler', () => {
    const { sidebar } = stageOfTwo();
    assert.ok(stage.count > 0, 'precondition: handler connected');
    sidebar.disable();
    assert.equal(stage.count, 0, 'stage handler leaked past disable()');
});

test('Show Desktop placeholders are dropped once another stage is shown', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const b = new FakeWindow('appB');
    ws0.adopt(a); ws0.adopt(b);
    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    b.minimize(); deliver(sidebar, [b]);             // b parked as its own card
    for (let i = 0; i < 5; i++) {
        const parked = sidebar._getInactiveGroups()[0];
        sidebar._showDesktop(); deliver(sidebar, [a, b].filter(w => w.minimized));
        sidebar._swapToGroup(parked); deliver(sidebar, [a, b]);
    }
    const empty = sidebar._groups.filter(g => g.windows.size === 0);
    assert.equal(empty.length, 0, `${empty.length} empty stages left behind after 5 Show Desktop round trips`);
    assert.equal(sidebar._groups.length, 2, 'only the two real stages remain');
});

/* ═══ restoring a window from the dock / alt-tab ═══════════════════ */

/** Two real stages on one workspace: {c,d} parked by a swap, {a,b} active. */
function twoStages() {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const c = new FakeWindow('appC'); const d = new FakeWindow('appD');
    ws0.adopt(c); ws0.adopt(d);
    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    const stageCD = sidebar._getActiveGroup();
    // Park {c,d} the way the sidebar does, then open a and b on the fresh stage.
    sidebar._showDesktop();
    deliver(sidebar, [c, d]);
    const a = new FakeWindow('appA'); const b = new FakeWindow('appB');
    ws0.adopt(a); ws0.adopt(b);
    sidebar._onWindowMap(a); sidebar._onWindowMap(b);
    return { sidebar, a, b, c, d, stageCD };
}

test('restoring a window of a parked stage brings that whole stage forward', () => {
    const { sidebar, a, b, c, d, stageCD } = twoStages();
    assert.ok(c.minimized && d.minimized && !a.minimized, 'precondition');

    c.unminimize(); deliver(sidebar, [c]);       // user picks c in the dock
    deliver(sidebar, [a, b, d]);                 // the swap's own signals arrive

    assert.equal(sidebar._getActiveGroup(), stageCD, 'c\'s stage must become the active one');
    assert.ok(!d.minimized, 'c\'s stage-mate must come back with it');
    assert.ok(a.minimized && b.minimized, 'the stage that was on screen must be parked');
    assert.equal(stageCD.windows.size, 2, 'the restored stage must not be split');
    assert.ok(c.activated > 0, 'the window the user picked must get focus');
});

test('restoring a window the user minimized on its own just rejoins the current stage', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const b = new FakeWindow('appB');
    ws0.adopt(a); ws0.adopt(b);
    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    const active = sidebar._getActiveGroup();

    b.minimize(); deliver(sidebar, [b]);         // b becomes its own card
    b.unminimize(); deliver(sidebar, [b]);       // and is restored from the dock

    assert.equal(sidebar._getActiveGroup(), active, 'no stage swap for a lone minimized window');
    assert.ok(!a.minimized, 'the current stage must stay on screen');
    assert.ok(active.windows.has(b), 'b rejoins the stage it was minimized from');
});

test('a lone minimized window shown as a stage becomes a real stage', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const b = new FakeWindow('appB');
    ws0.adopt(a); ws0.adopt(b);
    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    b.minimize(); deliver(sidebar, [b]);
    const lone = sidebar._findGroupForWindow(b);
    assert.ok(lone.fromMinimize, 'precondition: marked as a minimized window');

    sidebar._swapToGroup(lone);                  // user clicks its card
    assert.equal(lone.fromMinimize, undefined,
        'once shown as a stage, parking it again must swap it back whole');
});

/* ═══ an explicit reveal must not hide itself straight away ═════════ */

test('the keyboard toggle does not auto-hide while the pointer is elsewhere', () => {
    wsm.reset(1);
    const sidebar = new StageSidebar(makeSettings({
        'sidebar-auto-hide': true,
        'show-on-empty-workspace': false,
    }));
    sidebar._build();
    try {
        setPointer(1500, 500);   // nowhere near the sidebar
        sidebar._toggleVisible();

        assert.equal(sidebar._visible, true, 'the toggle must reveal the sidebar');
        assert.equal(sidebar._hideTimer, null,
            'an explicit reveal that hides itself 800ms later makes the shortcut useless');
    } finally { sidebar.disable(); }
});

/* ═══ Stack: dragging to merge must show something ══════════════════ */

test('dragging a Stack card past the threshold raises a ghost that follows the pointer', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA', { actor: makeWindowActor(800, 600) }); ws0.adopt(a);

    const sidebar = new StageSidebar(makeSettings({ 'sidebar-mode': 'apps' }));
    sidebar._build();
    try {
        const group = { key: 'appA', app: null, apps: [], windows: [a] };
        sidebar._startAppDragCandidate(group, null);
        assert.equal(sidebar._appDragGhost, null, 'no ghost before the threshold');

        // A nudge below the threshold must still show nothing.
        sidebar._onAppDragMotion({ get_coords: () => [3, 3] });
        assert.equal(sidebar._appDragGhost, null, 'a 3px nudge is a click, not a drag');

        sidebar._onAppDragMotion({ get_coords: () => [400, 300] });
        assert.ok(sidebar._appDragGhost, 'past the threshold the drag must show a ghost');
        const [gx, gy] = sidebar._appDragGhost.get_position();
        assert.ok(gx < 400 && gy < 300, 'the ghost should be centred on the pointer');

        sidebar._onAppDragMotion({ get_coords: () => [600, 500] });
        const [gx2] = sidebar._appDragGhost.get_position();
        assert.ok(gx2 > gx, 'the ghost must track further pointer motion');

        sidebar._cancelAppDrag();
        assert.equal(sidebar._appDragGhost, null, 'the ghost must go with the drag');
    } finally { sidebar.disable(); }
});

test('disable() destroys a drag ghost left in flight', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA', { actor: makeWindowActor(800, 600) }); ws0.adopt(a);

    const sidebar = new StageSidebar(makeSettings({ 'sidebar-mode': 'apps' }));
    sidebar._build();
    sidebar._startAppDragCandidate({ key: 'appA', apps: [], windows: [a] }, null);
    sidebar._onAppDragMotion({ get_coords: () => [400, 300] });
    const ghost = sidebar._appDragGhost;
    assert.ok(ghost, 'precondition: a ghost is in flight');

    sidebar.disable();
    assert.ok(ghost.destroyed, 'disable() must not leak the ghost actor');
    assert.equal(sidebar._appDragGhost, null);
});

/* ═══ Arc: a click switches to the group, hover is what fans it ═════ */

function arcWithGroups(settings) {
    const arc = new ArcSidebar(settings ?? makeSettings());
    arc._scaleFactor = 1;
    arc._monitor = arc._pickMonitor();
    arc._loadMergeMap(); arc._loadOrderMap(); arc._loadConfig();
    arc._buildUI();
    return arc;
}

test('clicking a multi-window group activates it instead of fanning it open', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);
    const b = new FakeWindow('appB'); ws0.adopt(b);

    const arc = arcWithGroups();
    try {
        arc._buildGroups();
        // Put both windows in one group so the old code would have fanned.
        arc._mergeApps(arc._groups[1].windowKeys[0], arc._groups[0].windowKeys[0]);
        arc._buildGroups();
        assert.equal(arc._groups.length, 1, 'precondition: one merged group');
        assert.ok(arc._groups[0].windowKeys.length > 1, 'precondition: multi-window');

        let activated = 0, fanned = 0;
        arc._activateGroup = () => { activated++; };
        arc._fanGroup = () => { fanned++; };
        arc._redraw();

        const grid = arc._containers[0]._grid;
        grid._fanned = false;
        grid._cards[0].card.emit('button-press-event', { get_button: () => 1 });
        grid._cards[0].card.emit('button-release-event', { get_button: () => 1 });

        assert.equal(activated, 1, 'a click must bring the group forward');
        assert.equal(fanned, 0, 'a click must not merely fan the group in the sidebar');
    } finally { arc.disable(); }
});

test('hover fan-out is on by default, so a group can still be peeked into', () => {
    const arc = new ArcSidebar(makeSettings());
    arc._scaleFactor = 1;
    arc._monitor = arc._pickMonitor();
    arc._loadMergeMap(); arc._loadOrderMap(); arc._loadConfig();
    assert.ok(arc._fanDelay > 0,
        'with click-to-fan removed, a 0 hover delay would leave no way to fan at all');
});

/* ═══ the drag-poll safety net must not leave a dead id behind ══════ */

test('resolving a drag through the poll timer untracks its id', () => {
    wsm.reset(1);
    const arc = new ArcSidebar(makeSettings());
    arc._scaleFactor = 1;
    arc._monitor = arc._pickMonitor();
    arc._loadMergeMap(); arc._loadOrderMap(); arc._loadConfig();
    arc._activateGroup = () => {};
    arc._commitDrag = () => {};

    arc._drag = { group: { windowKeys: ['w1'] }, startX: 0, startY: 0, moved: false };
    arc._armDragPollTimer();
    const id = arc._dragPollTimer;
    assert.ok(arc._timers.includes(id), 'precondition: the poll id is tracked');

    // Button already released (the stub pointer reports no buttons held), so
    // the timer takes the resolve-and-stop branch.
    clock.advance(60);

    assert.equal(arc._dragPollTimer, null, 'the field must be cleared');
    assert.ok(!arc._timers.includes(id),
        'a resolved poll timer left its dead id in _timers; disable() would ' +
        'then source_remove a stale (possibly recycled) id');
    arc.disable();
});

/* ═══ every user-visible Stack setting refreshes live ═══════════════ */

test('toggling show-workspace-current refreshes the sidebar', () => {
    wsm.reset(1);
    const settings = makeSettings({ 'sidebar-mode': 'workspaces' });
    const sidebar = makeSidebar(settings);
    sidebar._build();
    sidebar._wire();
    sidebar._visible = true;
    const before = sidebar._refreshCount ?? 0;

    settings.set('show-workspace-current', false);

    assert.ok((sidebar._refreshCount ?? 0) > before,
        'the setting is cached in _renderSignature(), so it needs a changed:: handler');
    sidebar.disable();
});

/* ═══ ArcSidebar: geometry must follow the PRIMARY monitor ══════════ */

test('arc reads the work area of the primary monitor, not always monitor 0', () => {
    wsm.reset(1);
    // Two heads, primary is the SECOND one and a different size, so using the
    // wrong index produces visibly wrong geometry rather than the same numbers.
    setMonitors([
        { x: 0,    y: 0, width: 1280, height: 720,  index: 0 },
        { x: 1280, y: 0, width: 1920, height: 1080, index: 1 },
    ], 1);

    const arc = new ArcSidebar(makeSettings());
    arc._scaleFactor = 1;
    arc._monitor = arc._pickMonitor();
    arc._loadMergeMap(); arc._loadOrderMap(); arc._loadConfig();

    assert.equal(Main.layoutManager.lastWorkAreaIndex, 1,
        'arc asked for the work area of monitor 0 while sitting on monitor 1');
});

/* ═══ ArcSidebar: the same edge dwell as the stack layout (#2) ════════ */

function arcEdgeSidebar(delay) {
    const arc = new ArcSidebar(makeSettings({ 'edge-trigger-delay': delay }));
    arc._scaleFactor = 1;
    arc._monitor = Main.layoutManager.primaryMonitor;
    arc._loadMergeMap(); arc._loadOrderMap(); arc._loadConfig();
    arc._buildUI();
    arc._shown = 0;
    arc._showPanel = () => { arc._shown++; };
    return arc;
}

test('arc: resting on the edge for the full dwell reveals the panel', () => {
    const arc = arcEdgeSidebar(250);
    arc._edge.emit('enter-event');
    assert.equal(arc._shown, 0, 'must not reveal before the dwell elapses');
    clock.advance(250);
    assert.equal(arc._shown, 1);
    arc._destroyUI();
});

test('arc: brushing past the edge cancels the pending reveal', () => {
    const arc = arcEdgeSidebar(250);
    arc._edge.emit('enter-event');
    assert.ok(arc._timers.includes(arc._edgeTimer),
        'the arc dwell timer must be tracked in _timers too');
    arc._edge.emit('leave-event');
    assert.equal(arc._edgeTimer, null);
    clock.advance(1000);
    assert.equal(arc._shown, 0, 'a brush-past must never reveal the arc panel');
    arc._destroyUI();
});

test('arc: a delay of 0 keeps the original instant reveal', () => {
    const arc = arcEdgeSidebar(0);
    arc._edge.emit('enter-event');
    assert.equal(arc._shown, 1);
    assert.equal(arc._edgeTimer, null, 'delay 0 must not arm a timer');
    arc._destroyUI();
});

/* ═══ #10: opt-in maximize-to-new-stage ═══════════════════════════════ */

/** ws0 active with three windows in one stage; `a` is the one to maximize. */
function maxGroupSidebar(overrides = {}) {
    const [ws0] = wsm.reset(2);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA');
    const b = new FakeWindow('appB');
    const c = new FakeWindow('appC');
    [a, b, c].forEach(w => ws0.adopt(w));

    const sidebar = makeSidebar(makeSettings({
        'maximize-behavior': 'stage', ...overrides,
    }));
    sidebar._initGroups();
    return { sidebar, ws0, a, b, c };
}

test('#10 maximizing promotes the window into a stage of its own', () => {
    const { sidebar, a, b, c } = maxGroupSidebar();
    const originId = sidebar._findGroupForWindow(a).id;

    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);

    const active = sidebar._getActiveGroup();
    assert.notEqual(active.id, originId, 'a new stage should have become active');
    assert.deepEqual([...active.windows], [a], 'the promoted stage holds only the maximized window');
    assert.equal(b.minimized, true, 'former stage-mates are parked as a card');
    assert.equal(c.minimized, true);
    assert.equal(a.minimized, false, 'the maximized window itself stays on screen');
});

test('#10 unmaximizing returns the window to the stage it came from', () => {
    const { sidebar, a, b, c } = maxGroupSidebar();
    const originId = sidebar._findGroupForWindow(a).id;

    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);
    sidebar._onWindowSizeChange(a, Meta.SizeChange.UNMAXIMIZE);

    const active = sidebar._getActiveGroup();
    assert.equal(active.id, originId, 'should be back on the original stage');
    assert.equal(active.windows.size, 3);
    [a, b, c].forEach(w => assert.ok(active.windows.has(w),
        'the original stage should hold all three windows again'));
    assert.equal(b.minimized, false, 'stage-mates come back with it');
    assert.equal(sidebar._maxOrigin.size, 0, 'the origin record is consumed, not leaked');
});

test('#10 the promotion is inert while the setting is off', () => {
    const { sidebar, a, b } = maxGroupSidebar({ 'maximize-behavior': 'none' });
    const before = sidebar._groups.length;

    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);

    assert.equal(sidebar._groups.length, before, 'no stage should have been created');
    assert.equal(b.minimized, false, 'nothing should have been parked');
});

test('#10 the promotion is inert outside groups mode', () => {
    const { sidebar, a, b } = maxGroupSidebar({ 'sidebar-mode': 'apps' });
    const before = sidebar._groups.length;

    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);

    assert.equal(sidebar._groups.length, before, 'apps mode derives its stages elsewhere');
    assert.equal(b.minimized, false);
});

test('#10 maximize-to-workspace wins when both maximize options are on', () => {
    const { sidebar, a, b } = maxGroupSidebar({ 'maximize-behavior': 'workspace' });
    const before = sidebar._groups.length;

    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);

    assert.equal(sidebar._groups.length, before,
        'promoting as well would strand an empty stage on the old workspace');
    assert.equal(b.minimized, false);
});

test('#10 a promoted window still gets home if the setting is switched off', () => {
    const { sidebar, a } = maxGroupSidebar();
    const originId = sidebar._findGroupForWindow(a).id;

    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);
    sidebar._settings.set('maximize-behavior', 'none');
    sidebar._onWindowSizeChange(a, Meta.SizeChange.UNMAXIMIZE);

    assert.equal(sidebar._getActiveGroup().id, originId,
        'the return path must not be gated on the setting');
});

test('#10 maximizing a window already alone on its stage is a no-op', () => {
    const [ws0] = wsm.reset(2);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);

    const sidebar = makeSidebar(makeSettings({
        'maximize-behavior': 'stage',
    }));
    sidebar._initGroups();
    const before = sidebar._groups.length;

    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);

    assert.equal(sidebar._groups.length, before, 'must not spawn a duplicate lone stage');
    assert.equal(sidebar._maxOrigin.size, 0, 'nothing to return to, so nothing recorded');
});

test('#10 maximizing on a background workspace leaves that stage intact', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws1);
    const a = new FakeWindow('appA');
    const b = new FakeWindow('appB');
    [a, b].forEach(w => ws1.adopt(w));

    const sidebar = makeSidebar(makeSettings({
        'maximize-behavior': 'stage',
    }));
    sidebar._initGroups();
    switchWorkspace(sidebar, ws0);   // ws1 is now in the background

    const originId = sidebar._findGroupForWindow(a).id;
    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);

    assert.equal(sidebar._findGroupForWindow(a)?.id, originId,
        'a swap that cannot run must not half-split a background stage');
    assert.equal(sidebar._maxOrigin.size, 0, 'and must not record an origin it never acted on');
});

test('#10 unmaximizing after switching away still rejoins, and the stage survives', () => {
    const [ws0, ws1] = wsm.reset(2);
    wsm.setActive(ws1);
    const a = new FakeWindow('appA');
    const b = new FakeWindow('appB');
    [a, b].forEach(w => ws1.adopt(w));

    const sidebar = makeSidebar(makeSettings({
        'maximize-behavior': 'stage',
    }));
    sidebar._initGroups();
    const originId = sidebar._findGroupForWindow(a).id;

    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);
    switchWorkspace(sidebar, ws0);                                 // leave ws1
    sidebar._onWindowSizeChange(a, Meta.SizeChange.UNMAXIMIZE);    // unmaximize off-screen

    const home = sidebar._findGroupForWindow(a);
    assert.equal(home?.id, originId, 'the window must rejoin its origin stage even off-screen');
    assert.ok(home.windows.has(b), 'and the stage must still hold its other windows');

    switchWorkspace(sidebar, ws1);   // come back
    assert.ok(sidebar._findGroupForWindow(a), 'the window must still belong to a stage after returning');
});

test('#10 unmaximizing a parked window must not yank the user off their stage', () => {
    const [ws0] = wsm.reset(2);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA');
    const b = new FakeWindow('appB');
    const d = new FakeWindow('appD');
    [a, b, d].forEach(w => ws0.adopt(w));

    const sidebar = makeSidebar(makeSettings({ 'maximize-behavior': 'stage' }));
    sidebar._initGroups();

    d.minimize(); deliver(sidebar, [a, b, d]);              // park D as its own stage
    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);
    deliver(sidebar, [a, b, d]);                            // A promoted, B parked

    const dStage = sidebar._groups.find(g => g.windows.has(d));
    sidebar._swapToGroup(dStage);                           // user clicks D's card
    deliver(sidebar, [a, b, d]);
    assert.ok(sidebar._getActiveGroup().windows.has(d), 'precondition: user is on D\'s stage');

    // A is parked off-screen; unmaximizing it is bookkeeping, not a navigation request.
    sidebar._onWindowSizeChange(a, Meta.SizeChange.UNMAXIMIZE);
    deliver(sidebar, [a, b, d]);

    assert.ok(sidebar._getActiveGroup().windows.has(d),
        'unmaximizing an off-screen window swapped the user away from the stage they chose');
    assert.ok(sidebar._findGroupForWindow(a).windows.has(b),
        'A should still have rejoined its origin stage in the background');
});

test('#10 unmaximize strands nothing when the origin stage died meanwhile', () => {
    const { sidebar, a, b, c } = maxGroupSidebar();

    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);
    // The whole origin stage is closed while `a` is maximized.
    sidebar._onWindowDestroy(b);
    sidebar._onWindowDestroy(c);
    sidebar._onWindowSizeChange(a, Meta.SizeChange.UNMAXIMIZE);

    assert.equal(a.minimized, false, 'the surviving window must stay on screen');
    assert.ok(sidebar._findGroupForWindow(a), 'it must still belong to some stage');
});

test('#10 disable() clears the origin map and _wire() binds size-change', () => {
    const { sidebar, a } = maxGroupSidebar();
    sidebar._onWindowSizeChange(a, Meta.SizeChange.MAXIMIZE);
    assert.equal(sidebar._maxOrigin.size, 1, 'precondition: an origin is recorded');

    sidebar._build();
    sidebar._wire();
    assert.ok(sidebar._sigSources.has(windowManager),
        '_wire() must connect the window manager for size-change');
    sidebar.disable();
    assert.equal(sidebar._maxOrigin.size, 0, 'disable() must drop every origin record');
});

/* ═══ the lock screen disables extensions: state must survive it ═══ */

/** Lock (the shell disables every extension) and unlock (enables them again). */
function lockCycle(ext) {
    Main.sessionMode.isLocked = true;
    ext.disable();
    Main.sessionMode.isLocked = false;
    ext.enable();
}

test('a parked stage survives the lock screen whole, not split per app', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const b = new FakeWindow('appB');
    const c = new FakeWindow('appC', { minimized: true });
    [a, b, c].forEach(w => ws0.adopt(w));
    const ext = new StageManagerExtension();
    ext._fakeSettings = makeSettings();
    ext.enable();
    try {
        const before = ext._side;
        before._swapToGroup(before._findGroupForWindow(c));   // park {a,b}, show {c}
        deliver(before, [a, b, c]);
        lockCycle(ext);
        const side = ext._side;
        assert.notEqual(side, before, 'precondition: a fresh sidebar after unlock');
        const ab = side._findGroupForWindow(a);
        assert.ok(ab?.windows.has(b), 'the parked stage {a,b} was split by the lock screen');
        assert.ok(!ab.fromMinimize, 'it must still swap back as a stage, not as lone windows');
        assert.equal(side._getActiveGroup(), side._findGroupForWindow(c), 'c stays the stage on screen');
    } finally { ext.disable(); }
});

test('a window closed while locked drops out of its restored stage', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const b = new FakeWindow('appB');
    const c = new FakeWindow('appC', { minimized: true });
    [a, b, c].forEach(w => ws0.adopt(w));
    const ext = new StageManagerExtension();
    ext._fakeSettings = makeSettings();
    ext.enable();
    try {
        ext._side._swapToGroup(ext._side._findGroupForWindow(c));
        deliver(ext._side, [a, b, c]);
        Main.sessionMode.isLocked = true;
        ext.disable();
        b.unmanage();                      // the app quit while the screen was locked
        Main.sessionMode.isLocked = false;
        ext.enable();
        const ab = ext._side._findGroupForWindow(a);
        assert.ok(ab && !ab.windows.has(b) && ab.windows.size === 1);
    } finally { ext.disable(); }
});

test('turning the extension off keeps nothing; only the lock screen does', () => {
    wsm.reset(1);
    const ext = new StageManagerExtension();
    ext._fakeSettings = makeSettings();
    ext.enable();
    ext.disable();
    assert.equal(ext._lockState, null, 'state kept past a real disable');
});

test('a window maximized onto its own workspace still goes home after the lock screen', () => {
    const [ws0, ws1] = wsm.reset(2);
    const a = new FakeWindow('appA'); const s = new FakeWindow('appS');
    ws0.adopt(a); ws0.adopt(s); wsm.setActive(ws0);
    const ext = new StageManagerExtension();
    ext._fakeSettings = makeSettings({ 'maximize-behavior': 'workspace' });
    ext.enable();
    try {
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
        clock.advance(100);
        assert.equal(a.get_workspace(), ws1, 'precondition: moved to its own workspace');
        lockCycle(ext);
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.UNMAXIMIZE);
        clock.advance(100);
        assert.equal(a.get_workspace(), ws0, 'unmaximize after an unlock stranded the window');
    } finally { ext.disable(); }
});

test('maximize origins are dropped, not misapplied, if workspaces changed while locked', () => {
    const [ws0, ws1] = wsm.reset(2);
    const a = new FakeWindow('appA'); const s = new FakeWindow('appS');
    ws0.adopt(a); ws0.adopt(s); wsm.setActive(ws0);
    const mtw = new MaximizeToWorkspace(makeSettings(), { n: 3, origins: [[a.get_stable_sequence(), 0]] });
    mtw.enable();
    try {
        assert.equal(mtw._origin.size, 0, 'an index from a different workspace layout was trusted');
    } finally { mtw.disable(); }
    void ws1;
});

test('Arc keeps its drag-made groups across the lock screen', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const b = new FakeWindow('appB');
    ws0.adopt(a); ws0.adopt(b);
    const ext = new StageManagerExtension();
    ext._fakeSettings = makeSettings({ 'sidebar-layout': 'arc' });
    ext.enable();
    try {
        ext._side._mergeApps(arc0WindowKey(a), arc0WindowKey(b));
        const merged = [...ext._side._mergeMap];
        lockCycle(ext);
        assert.deepEqual([...ext._side._mergeMap], merged, 'drag-made groups vanished on unlock');
    } finally { ext.disable(); }
});

/* ═══ a window closed while not on screen ═════════════════════════ */

test('closing a window that was maximized away forgets it (mutter sends no destroy hook)', () => {
    const [ws0, ws1] = wsm.reset(2);
    const a = new FakeWindow('appA'); const s = new FakeWindow('appS');
    ws0.adopt(a); ws0.adopt(s); wsm.setActive(ws0);
    const mtw = new MaximizeToWorkspace(makeSettings({ 'maximize-behavior': 'workspace' }));
    mtw.enable();
    try {
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
        clock.advance(100);
        wsm.setActive(ws0);              // user went back; a sits alone on ws1
        a.unmanage();
        assert.equal(mtw._origin.size, 0, 'the closed window is still held in the origin map');
        assert.equal(a.signalCount, 0, 'its unmanaged handler was left connected');
        assert.ok(!mtw._sigSources.has(a));
    } finally { mtw.disable(); }
    void ws1;
});

test('a window closed while parked leaves its stage', () => {
    const { sidebar, c, d, stageCD } = twoStages();
    sidebar._wire();
    try {
        c.unmanage(); d.unmanage();      // quit from the dock: no wm destroy for hidden windows
        display.emit('restacked');
        clock.advance(200);
        assert.ok(!sidebar._groups.includes(stageCD), 'a stage of closed windows kept its card');
        assert.equal(sidebar._findGroupForWindow(c), null);
    } finally { sidebar.disable(); }
});

/* ═══ windows changed during a workspace switch (no wm hooks) ═══════ */

test('a parked window restored with no unminimize signal still brings its stage forward', () => {
    const { sidebar, a, b, d, stageCD } = twoStages();
    const c = [...stageCD.windows].find(w => w.appId === 'appC');
    sidebar._wire();
    try {
        // Alt-tab from another workspace: mutter unminimizes during the switch
        // animation and skips the effect hook, so only the restack is seen.
        c.minimized = false;
        display.emit('restacked');
        clock.advance(200);
        deliver(sidebar, [a, b, d]);
        assert.equal(sidebar._getActiveGroup(), stageCD, 'the restored window\'s stage must be the one on screen');
        assert.ok(!d.minimized, 'its stage-mate comes back with it');
        assert.ok(a.minimized && b.minimized, 'the other stage is parked, not left showing under it');
    } finally { sidebar.disable(); }
});

test('a window minimized with no signal is parked, not counted on screen', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const b = new FakeWindow('appB');
    ws0.adopt(a); ws0.adopt(b);
    const sidebar = makeSidebar(makeSettings());
    sidebar._wire(); sidebar._initGroups();
    try {
        b.minimized = true;
        display.emit('restacked');
        clock.advance(200);
        assert.ok(!sidebar._isActiveGroup(sidebar._findGroupForWindow(b)), 'b would have had no card');
        assert.ok(sidebar._isActiveGroup(sidebar._findGroupForWindow(a)));
    } finally { sidebar.disable(); }
});

test('a window opened with no map signal joins the stage on screen', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);
    const sidebar = makeSidebar(makeSettings());
    sidebar._wire(); sidebar._initGroups();
    try {
        const n = new FakeWindow('appN'); ws0.adopt(n);
        display.emit('restacked');
        clock.advance(200);
        assert.ok(sidebar._getActiveGroup().windows.has(n), 'the new window belonged to no stage');
    } finally { sidebar.disable(); }
});

test('a window that cannot be minimized never flips the stage back', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const pinned = new FakeWindow('appP');
    pinned.canMinimize = false;
    const c = new FakeWindow('appC', { minimized: true });
    [a, pinned, c].forEach(w => ws0.adopt(w));
    const sidebar = makeSidebar(makeSettings());
    sidebar._wire(); sidebar._initGroups();
    try {
        const target = sidebar._findGroupForWindow(c);
        sidebar._swapToGroup(target);
        deliver(sidebar, [a, c]);
        clock.advance(3000);             // past the swap's expectation window
        display.emit('restacked');
        clock.advance(200);
        assert.equal(sidebar._getActiveGroup(), target, 'the user\'s swap was undone');
        assert.equal(pinned.minimized, false);
    } finally { sidebar.disable(); }
});

test('switching sidebar-mode away and back re-derives who is parked', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const b = new FakeWindow('appB');
    const c = new FakeWindow('appC', { minimized: true });
    [a, b, c].forEach(w => ws0.adopt(w));
    const settings = makeSettings();
    const sidebar = makeSidebar(settings);
    sidebar._wire(); sidebar._initGroups();
    try {
        settings.set('sidebar-mode', 'all-windows');
        b.minimize(); c.unminimize(); deliver(sidebar, [b, c]);   // not tracked in this mode
        settings.set('sidebar-mode', 'groups');
        assert.ok(!sidebar._isActiveGroup(sidebar._findGroupForWindow(b)), 'b is minimized but still counted on screen');
        assert.ok(sidebar._isActiveGroup(sidebar._findGroupForWindow(c)), 'c is on screen but still drawn as a card');
    } finally { sidebar.disable(); }
});

/* ═══ windows on every workspace belong to no stage ═════════════════ */

test('a window stuck to all workspaces never joins a stage or gets minimized by one', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const pip = new FakeWindow('pip', { sticky: true });
    ws0.adopt(a); ws0.adopt(pip);
    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    assert.equal(sidebar._findGroupForWindow(pip), null, 'a window on every workspace joined one stage');
    sidebar._showDesktop();
    assert.equal(pip.minimized, false, 'a stage swap minimized a window shown on every workspace');
});

test('a window stuck after joining a stage is released from it', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'); const b = new FakeWindow('appB');
    ws0.adopt(a); ws0.adopt(b);
    const sidebar = makeSidebar(makeSettings());
    sidebar._wire(); sidebar._initGroups();
    try {
        b.sticky = true;                 // "Always on Visible Workspace" from the window menu
        display.emit('restacked');
        clock.advance(200);
        assert.equal(sidebar._findGroupForWindow(b), null);
    } finally { sidebar.disable(); }
});

/* ═══ auto-hide: the card column drives hover ═══════════════════════ */

const crossing = related => ({ get_related: () => related });

test('leaving the card column through its blank space still hides an auto-hide sidebar', () => {
    wsm.reset(1);
    const sidebar = realSidebar(makeSettings({ 'sidebar-auto-hide': true, 'show-on-empty-workspace': false }));
    try {
        sidebar._box.emit('enter-event', crossing(null));
        assert.equal(sidebar._hovered, true, 'entering the cards must count as hover');
        sidebar._box.emit('leave-event', crossing(sidebar._box));   // card → gap between cards
        assert.equal(sidebar._hovered, true, 'a move inside the column is not leaving it');
        setPointer(1500, 500);
        sidebar._box.emit('leave-event', crossing(new St.Widget()));   // out to the window
        assert.equal(sidebar._hovered, false, 'hover stuck on after the pointer left the column');
        clock.advance(1000);
        assert.equal(sidebar._visible, false, 'the sidebar stayed open over the window');
    } finally { sidebar.disable(); }
});

test('a pointer resting below the cards does not hold an auto-hide sidebar open', () => {
    wsm.reset(1);
    const sidebar = realSidebar(makeSettings({ 'sidebar-auto-hide': true, 'show-on-empty-workspace': false }));
    try {
        sidebar._panel.set_position(0, 32);   // settled
        sidebar._box.set_position(20, 0);
        sidebar._box.set_size(180, 300);      // two cards at the top of the column
        setPointer(100, 200);
        sidebar._scheduleHide();
        clock.advance(1000);
        assert.equal(sidebar._visible, true, 'a pointer on the cards must keep it open');
        setPointer(100, 900);                 // same column, below the cards: over the window
        clock.advance(1000);
        assert.equal(sidebar._visible, false, 'the empty part of the column held the sidebar open');
    } finally { sidebar.disable(); }
});

test('hiding by hand stops a pending auto-hide timer', () => {
    wsm.reset(1);
    const sidebar = realSidebar(makeSettings({ 'sidebar-auto-hide': true, 'show-on-empty-workspace': false }));
    try {
        setPointer(2, 400);                   // on the edge strip: the timer keeps re-arming
        sidebar._scheduleHide();
        sidebar._hide();
        assert.equal(sidebar._hideTimer, null, 'a timer kept firing for a sidebar already hidden');
    } finally { sidebar.disable(); }
});

/* ═══ hidden means hidden: the parked spot can be on another monitor ═══ */

/** Make an actor's ease finish at once, as Clutter does when the transition ends. */
function easeFinishes(actor) {
    actor.ease = p => {
        if ('x' in p) actor.set_position(p.x, p.y);
        p.onComplete?.();
    };
}

test('the hidden Stack panel is not drawn, so it cannot sit on a monitor to the left', () => {
    setMonitors([{ x: 0, y: 0, width: 1920, height: 1080, index: 0 },
        { x: 1920, y: 0, width: 1920, height: 1080, index: 1 }], 1);
    wsm.reset(1);
    const sidebar = new StageSidebar(makeSettings({ 'sidebar-auto-hide': true, 'show-on-empty-workspace': false }));
    sidebar._build();
    try {
        assert.equal(sidebar._panel.visible, false, 'built hidden, it was drawn at its parked spot');
        easeFinishes(sidebar._panel);
        sidebar._show();
        assert.equal(sidebar._panel.visible, true);
        sidebar._hide();
        assert.equal(sidebar._panel.x, 1700, 'precondition: parked on the left monitor\'s edge');
        assert.equal(sidebar._panel.visible, false, 'its cards stayed drawn and clickable there');
    } finally { sidebar.disable(); }
});

test('a reveal that interrupts the slide-out shows the panel again', () => {
    wsm.reset(1);
    const sidebar = new StageSidebar(makeSettings({ 'sidebar-auto-hide': true, 'show-on-empty-workspace': false }));
    sidebar._build();
    try {
        sidebar._show();
        sidebar._hide();                      // ease never completes: interrupted
        sidebar._show();
        assert.equal(sidebar._panel.visible, true);
    } finally { sidebar.disable(); }
});

test('the hidden Arc panel is not drawn or clickable where it parks', () => {
    wsm.reset(1);
    const arc = new ArcSidebar(makeSettings());
    arc.enable();
    try {
        assert.equal(arc._panel.visible, false, 'built hidden, Arc was drawn at its parked spot');
        easeFinishes(arc._panel);
        arc._showPanel();
        assert.equal(arc._panel.visible, true);
        arc._hidePanel();
        assert.equal(arc._panel.visible, false, 'faded out but still reactive: an invisible strip ate clicks');
    } finally { arc.disable(); }
});

/* ═══ Show Desktop leaves the sidebar up ═════════════════════════════ */

test('Show Desktop with auto-hide on brings the sidebar up over the empty desktop', () => {
    const { sidebar, a, b } = stageOfTwo({ 'sidebar-auto-hide': true });
    try {
        sidebar._showDesktop();
        assert.ok(a.minimized && b.minimized, 'precondition');
        assert.equal(sidebar._visible, true, 'every window vanished and the sidebar stayed hidden');
    } finally { sidebar.disable(); }
});

/* ═══ maximize-to-workspace vs Ubuntu's tiling-assistant ═════════════ */

test('a re-tile by tiling-assistant during our move does not bounce the window', () => {
    const [ws0, ws1] = wsm.reset(2);
    const a = new FakeWindow('appA'); const s = new FakeWindow('appS');
    ws0.adopt(a); ws0.adopt(s); wsm.setActive(ws0);
    const mtw = new MaximizeToWorkspace(makeSettings({ 'maximize-behavior': 'workspace' }));
    mtw.enable();
    // tiling-assistant re-tiles a window whose workspace changed: unmaximize, maximize.
    const move = a.change_workspace.bind(a);
    a.change_workspace = ws => {
        move(ws);
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.UNMAXIMIZE);
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
    };
    try {
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.MAXIMIZE);
        clock.advance(500);
        assert.equal(Main.wm.moves.length, 1, `the window was moved ${Main.wm.moves.length} times`);
        assert.equal(a.get_workspace(), ws1);
        assert.equal(wsm.get_active_workspace(), ws1);
        a.change_workspace = move;
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.UNMAXIMIZE);
        clock.advance(100);
        assert.equal(a.get_workspace(), ws0, 'it must still go home on unmaximize');
    } finally { mtw.disable(); }
});

/* ═══ past the card cap, the newest stages keep their cards ══════════ */

test('past the card cap, the window just minimized gets a card and the oldest is folded away', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const wins = Array.from({ length: 10 }, (_, i) => new FakeWindow(`app${i}`));
    wins.forEach(w => ws0.adopt(w));
    const sidebar = makeSidebar(makeSettings());
    sidebar._initGroups();
    for (const w of wins.slice(1)) { w.minimize(); deliver(sidebar, [w]); }   // 9 parked stages
    const shown = sidebar._shownInactiveGroups();
    assert.equal(shown.length, 8);
    assert.ok(shown.includes(sidebar._findGroupForWindow(wins[9])), 'the newest parked stage had no card');
    assert.ok(!shown.includes(sidebar._findGroupForWindow(wins[1])), 'the oldest should be the one behind +1');
    assert.deepEqual(shown, sidebar._getInactiveGroups().filter(g => shown.includes(g)), 'cards keep their order');
});

/* ═══ Arc: scrolling, clicks, reorder, new windows, hidden refresh ═══ */

function arcOf(n, over = {}) {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const wins = Array.from({ length: n }, (_, i) => new FakeWindow(`app${i}`));
    wins.forEach(w => ws0.adopt(w));
    const arc = arcWithGroups(makeSettings(over));
    arc._isVisible = true;
    arc._buildGroups();
    arc._redraw();
    return { arc, wins };
}

test('Arc: scrolling past the cards built at the last redraw builds the ones coming into view', () => {
    const { arc } = arcOf(12);
    try {
        assert.ok(!arc._containerByKey.has(arc._groups[9].key), 'precondition: card 9 not built at offset 0');
        arc._offset = 9;
        arc._updatePositions();
        const c = arc._containerByKey.get(arc._groups[9].key);
        assert.ok(c && c.visible, 'the front slot was empty after the scroll');
        const order = arc._containers.map(k => k._idx);
        assert.deepEqual(order, [...order].sort((x, y) => x - y), 'cards must stay in group order');
    } finally { arc.disable(); }
});

test('Arc: a release after the drag poll already resolved the press does nothing more', () => {
    const { arc, wins } = arcOf(2);
    try {
        let activations = 0;
        arc._activateGroup = () => { activations++; };
        const card = arc._containers[0]._grid._cards[0].card;
        card.emit('button-press-event', { get_button: () => 1 });
        setPointer(0, 0, 0);                  // Wayland clears the button before the release arrives
        clock.advance(60);                    // the poll resolves it
        card.emit('button-release-event', { get_button: () => 1 });
        assert.equal(activations, 1, `one click activated ${activations} times`);
    } finally { arc.disable(); }
    void wins;
});

test('Arc: a click resolved by the drag poll focuses the window that was clicked', () => {
    const { arc } = arcOf(1);
    try {
        let focus = null;
        arc._activateGroup = (_g, win) => { focus = win; };
        const { card, win } = arc._containers[0]._grid._cards[0];
        card.emit('button-press-event', { get_button: () => 1 });
        setPointer(0, 0, 0);
        clock.advance(60);
        assert.equal(focus, win);
    } finally { arc.disable(); }
});

test('Arc: activating a card never focuses the app\'s window from another card', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const b1 = new FakeWindow('brave'); const b2 = new FakeWindow('brave', { minimized: true });
    ws0.adopt(b1); ws0.adopt(b2);
    const arc = arcWithGroups();
    try {
        setFocus(b1);
        arc._trackFocus();                    // lastFocused for 'brave' = b1
        arc._buildGroups();
        const cardB2 = arc._groups.find(g => g.windows.includes(b2));
        const before = b1.activated;
        arc._activateGroup(cardB2);
        assert.equal(b1.activated, before, 'b1 (another card) was brought back');
        assert.ok(b2.activated > 0, 'the card\'s own window must get focus');
    } finally { arc.disable(); }
});

test('Arc: reorder picks the target in group order and in the panel\'s coordinates', () => {
    const { arc } = arcOf(12);
    try {
        arc._offset = 9;
        arc._updatePositions();
        arc._panel.set_position(0, 32);       // below the top bar: panel y ≠ stage y
        const src = arc._groups[9];
        const target = arc._containerByKey.get(arc._groups[10].key);
        const [tx, ty] = target.get_transformed_position();
        arc._reorderGroup(src, tx + target.width / 2, ty + target.height / 2);
        const order = [...arc._orderMap].sort((p, q) => p[1] - q[1]).map(([k]) => k);
        assert.equal(order.indexOf(src.key), 10, `dropped on card 10, landed at ${order.indexOf(src.key)}`);
    } finally { arc.disable(); }
});

test('Arc keep-visible off: windows opened together do not minimize each other', () => {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const old = new FakeWindow('appOld'); ws0.adopt(old);
    const arc = arcWithGroups(makeSettings({ 'arc-keep-visible': false }));
    try {
        const n1 = new FakeWindow('appN1'); const n2 = new FakeWindow('appN2');
        [n1, n2].forEach(w => { w.get_transient_for = () => null; ws0.adopt(w); });
        arc._onWindowCreated(n1); arc._onWindowCreated(n2);
        clock.advance(250);
        assert.ok(!n1.minimized && !n2.minimized, 'the app opened with nothing on screen');
        assert.ok(old.minimized, 'the older window still steps aside');
    } finally { arc.disable(); }
});

test('Arc does not rebuild its cards while hidden, and redraws on the way in', () => {
    const { arc } = arcOf(3);
    try {
        arc._isVisible = false;
        let redraws = 0;
        const redraw = arc._redraw.bind(arc);
        arc._redraw = () => { redraws++; redraw(); };
        arc._scheduleRefresh();
        clock.advance(100);
        assert.equal(redraws, 0, 'rebuilt every card for a carousel nobody can see');
        arc._showPanel();
        assert.equal(redraws, 1, 'the reveal must redraw what was skipped');
    } finally { arc.disable(); }
});

/* ═══ Arc: Show on Empty Desktop ═══════════════════════════════════════ */

function arcEnabled(over = {}) {
    const [ws0] = wsm.reset(1); wsm.setActive(ws0);
    const a = new FakeWindow('appA'), b = new FakeWindow('appB');
    ws0.adopt(a); ws0.adopt(b);
    setPointer(900, 500);                  // away from the carousel
    const arc = new ArcSidebar(makeSettings(over));
    arc.enable();
    return { arc, a, b };
}

test('Arc: minimizing every window brings the carousel up and keeps it up, like Stack', () => {
    const { arc, a, b } = arcEnabled();
    try {
        assert.equal(arc._isVisible, false, 'precondition: hidden while windows are on screen');
        a.minimize(); windowManager.emit('minimize');
        assert.equal(arc._isVisible, false, 'one window is still showing');
        b.minimize(); windowManager.emit('minimize');
        assert.equal(arc._isVisible, true, 'the desktop is empty, so the carousel must come up');
        arc._startHide(); clock.advance(5000);
        assert.equal(arc._isVisible, true, 'leaving it hid the only way back to the windows');
        b.unminimize(); windowManager.emit('unminimize');
        clock.advance(5000);
        assert.equal(arc._isVisible, false, 'a window came back, so it should step aside');
    } finally { arc.disable(); }
});

test('Arc: closing the last visible window also counts as an empty desktop', () => {
    const { arc, a, b } = arcEnabled();
    try {
        a.minimize(); windowManager.emit('minimize');
        b.unmanage(); display.emit('restacked');   // closed: no minimize signal
        assert.equal(arc._isVisible, true);
    } finally { arc.disable(); }
});

test('Arc: with Show on Empty Desktop off, minimizing everything leaves it hidden', () => {
    const { arc, a, b } = arcEnabled({ 'show-on-empty-workspace': false });
    try {
        a.minimize(); b.minimize(); windowManager.emit('minimize');
        assert.equal(arc._isVisible, false);
    } finally { arc.disable(); }
});

test('Arc: an empty desktop in the overview waits for it to close when Arc is hidden there', () => {
    const { arc, a, b } = arcEnabled({ 'arc-show-in-overview': false });
    try {
        arc._onOverviewShowing();
        a.minimize(); b.minimize(); windowManager.emit('minimize');
        assert.equal(arc._isVisible, false, 'shown in the overview against the setting');
        arc._onOverviewHidden();
        assert.equal(arc._isVisible, true, 'not shown once the overview closed');
    } finally { arc.disable(); }
});

/* ── report ──────────────────────────────────────────────────────────── */

let failed = 0;
for (const [status, name, msg] of results) {
    if (status === 'FAIL') { failed++; console.log(`FAIL  ${name}\n      → ${msg}`); }
    else console.log(`pass  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passing`);
process.exit(failed ? 1 : 0);
