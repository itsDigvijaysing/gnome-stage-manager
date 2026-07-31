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
    setFocus, Main, stage,
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

/* ═══ #5 — groups must be scoped to the active workspace ═════════════ */

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

/* ═══ #6 — stage arrangement must survive a workspace round-trip ═════ */

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

/* ═══ #7 — swap guard must not swallow real user minimizes ═══════════ */

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
        'user-minimized window is in no inactive stage — unreachable from the sidebar');
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

    // Compositor delivers the swap's signals LATE — after any time-based guard
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

/* ═══ #3 — show/hide must be interruptible ══════════════════════════ */

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
        '_show() during the hide animation was ignored — sidebar stays hidden');
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

/* ═══ #11 — leaving fullscreen restores an always-visible sidebar ════ */

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

/* ═══ #4 — the edge trigger is only live when it is needed ═══════════ */

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

/* ═══ #17 — thumbnails keep aspect ratio and drop the CSD shadow ═════ */

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

test('the pre-fix hardcoded 170px thumbnail really did overflow (regression guard)', () => {
    // The old code: fixed 170px thumb + fixed 14px fan-out per layer.
    // Three-deep stack in the default 220px sidebar: 170 + 2*14 + 2*14 = 226.
    const { outer } = cardWidth(220, 170, 3, 22, STACK_H);
    assert.equal(outer, 226);
    assert.ok(outer > 220,
        'the old geometry should be provably too wide — otherwise this guard is meaningless');
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
    // stack. Small is correct here — it is what fits.
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
        'vertical policy is NEVER — overflowing cards can never be reached');

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

test('only the card column is reactive — the panel around it stays click-through', () => {
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
        'a wheel event on a card did not scroll — the handler is only bound to the scroll view');
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
        'card is not rotated — the pill background would stay flat while its content tilts');
    assert.equal(thumb.rotation_angle_y, undefined,
        'thumbnail is still rotated independently of the pill that must contain it');
});

/* ═══ #19 — an empty stage must not produce negative geometry ════════ */

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

test('a swap captures a still for each window it parks', () => {
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
    assert.equal(actor.paintCount, 1, 'swap did not capture a still before minimizing');
    assert.ok(sidebar._snapshots.has(parked), 'no snapshot cached for the parked window');

    // Restoring it invalidates the still.
    parked.unminimize();
    deliver(sidebar, [parked]);
    assert.equal(sidebar._snapshots.has(parked), false,
        'stale snapshot kept after the window came back');
});

test('a window with a usable actor is cloned live, even when parked', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    const w = new FakeWindow('appA', { actor: makeWindowActor() });

    sidebar._captureSnapshot(w);
    assert.ok(sidebar._snapshots.has(w), 'precondition: a still is cached');

    w.minimized = true;                       // parked, but the actor is fine
    const inner = sidebar._makeWindowClone(w, 170, 110);
    assert.equal(inner.content, undefined,
        'used the cached still when a free live clone was available');
    assert.ok(inner.source, 'expected a live clone of the window actor');
});

test('the cached still takes over once the actor is gone', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    const w = new FakeWindow('appA', { actor: makeWindowActor() });

    sidebar._captureSnapshot(w);
    w.minimized = true;
    w._actor = null;                          // compositor actor went away

    const drawn = sidebar._makeWindowClone(w, 170, 110);
    assert.ok(drawn, 'should still produce a thumbnail from the cached still');
    assert.ok(drawn.content && drawn.content.token === 'content-1',
        'did not fall back to the cached still');
    // Size must come from the geometry captured at snapshot time (860x660).
    const scale = Math.min(170 / 860, 110 / 660);
    assert.equal(drawn.height, Math.round(660 * scale), 'wrong fallback height');
});

test('the snapshot cache is bounded and evicts oldest first', () => {
    wsm.reset(1);
    const sidebar = makeSidebar(makeSettings());
    const wins = [];
    for (let i = 0; i < 12; i++) {
        const w = new FakeWindow(`app${i}`, { actor: makeWindowActor() });
        wins.push(w);
        sidebar._captureSnapshot(w);
    }
    assert.ok(sidebar._snapshots.size <= 8,
        `cache grew to ${sidebar._snapshots.size} full-resolution textures`);
    assert.equal(sidebar._snapshots.has(wins[0]), false, 'oldest entry should have been evicted');
    assert.ok(sidebar._snapshots.has(wins[11]), 'newest entry should be kept');
});

/* ═══ #4 — stages past the cap are announced, not dropped silently ═══ */

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

/* ═══ #8 — unmaximize must return to the origin workspace object ═════ */

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

        settings.set('enable-maximize-to-workspace', false);
        windowManager.emit('size-change', { meta_window: a }, Meta.SizeChange.UNMAXIMIZE);
        clock.advance(100);

        assert.equal(a.get_workspace()?.label, ws1.label,
            'window was stranded on the spawned workspace after the setting was turned off');
    } finally { mtw.disable(); }
});

/* ═══ #9 — disable() tears down every actor and signal source ════════ */

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

/* ═══ #12 — timer bookkeeping must not untrack the wrong id ══════════ */

test('#12 a stale timer callback never untracks a different live timer', () => {
    wsm.reset(1);
    const mtw = new MaximizeToWorkspace(makeSettings());
    mtw._timers.push(9999);
    mtw._untrackTimer(4242);        // an id that was never tracked
    assert.deepEqual(mtw._timers, [9999],
        'splice(-1, 1) removed an unrelated live timer from tracking');
});

/* ═══ #18 — the render fingerprint must not skip real changes ════════ */

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

/* ═══ all-windows mode — every window, every workspace, read-only ═════ */

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

test('all-windows includes minimized windows — that is the point of the mode', () => {
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
        'the outgoing window must NOT be minimized — all-windows is read-only');
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

    // With the extension switched off the shortcut must do nothing at all.
    settings.set('enable-stage-sidebar', false);
    sidebar._toggleVisible();
    assert.equal(shown, 1, 'shortcut must be inert while the sidebar is disabled');
});

/* ═══ app merge/un-merge — grouping fold ═════════════════════════════ */

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

/* ═══ app merge/un-merge — persistence ═══════════════════════════════ */

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

/* ═══ app merge/un-merge — multi-icon rendering ══════════════════════ */

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

/* ═══ app merge/un-merge — drag gesture ══════════════════════════════ */

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
    // (cardA), never to whatever the pointer ends up over — so the drop
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

    // A per-app save (the pre-fix behaviour) would fire twice here — once per
    // app in the source group — each one a full settings write + sidebar
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

/* ═══ ArcSidebar — layout-swap wiring ═════════════════════════════════ */

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

/* ═══ ArcSidebar — _computeGeo() ═══════════════════════════════════════ */

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

/* ═══ ArcSidebar — data model: _buildGroups(), merge/order persistence ═ */

test('_buildGroups groups windows by app, one group per app with no merge', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);
    const b = new FakeWindow('appB'); ws0.adopt(b);
    const arc = new ArcSidebar(makeSettings());
    arc._loadMergeMap(); arc._loadOrderMap();
    arc._buildGroups();
    assert.equal(arc._groups.length, 2);
    assert.deepEqual(arc._groups.map(g => g.key).sort(), ['appA', 'appB']);
});

test('_buildGroups folds merged apps into one group with both windows', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);
    const b = new FakeWindow('appB'); ws0.adopt(b);
    const settings = makeSettings({ 'arc-merge-map': JSON.stringify({ appA: 'appA|appB', appB: 'appA|appB' }) });
    const arc = new ArcSidebar(settings);
    arc._loadMergeMap(); arc._loadOrderMap();
    arc._buildGroups();
    assert.equal(arc._groups.length, 1);
    assert.equal(arc._groups[0].appIds.length, 2);
    assert.equal(arc._groups[0].windows.length, 2);
});

test('_buildGroups sorts by order-map, unordered groups go last', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a = new FakeWindow('appA'); ws0.adopt(a);
    const b = new FakeWindow('appB'); ws0.adopt(b);
    const c = new FakeWindow('appC'); ws0.adopt(c);
    const settings = makeSettings({ 'arc-order-map': JSON.stringify({ appB: 0, appA: 1 }) });
    const arc = new ArcSidebar(settings);
    arc._loadMergeMap(); arc._loadOrderMap();
    arc._buildGroups();
    assert.deepEqual(arc._groups.map(g => g.key), ['appB', 'appA', 'appC']);
});

test('_buildGroups promotes the focused window to the front of its group', () => {
    const [ws0] = wsm.reset(1);
    wsm.setActive(ws0);
    const a1 = new FakeWindow('appA'); ws0.adopt(a1);
    const a2 = new FakeWindow('appA'); ws0.adopt(a2);
    setFocus(a2);
    const arc = new ArcSidebar(makeSettings());
    arc._loadMergeMap(); arc._loadOrderMap();
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
    assert.equal(JSON.parse(settings.get_string('arc-merge-map'))['appA'], arc._mergeMap.get('appA'));
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

/* ═══ ArcSidebar — card rendering: grid, stack/fan offsets, icon row ═══ */

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

/* ═══ ArcSidebar — _redraw() main render loop ══════════════════════════ */

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
    assert.equal(arc._cardTimers.size, 0);
    assert.equal(clock.pending, 0, 'no timers should remain pending after disable()');
});

/* ═══ ArcSidebar — drag: merge (outside) vs reorder (inside), un-merge ═ */

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
    const group = { app: sourceApp, apps: [sourceApp], windows: [source], appIds: ['appSource'], key: 'appSource' };
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
    global.get_pointer = () => [9999, 9999]; // release point — outside the panel rect
    try {
        arc._onCardRelease(container, group, 0, { get_button: () => 1 });
    } finally { global.get_pointer = origGetPointer; }
    assert.ok(arc._mergeMap.get('appSource'), 'expected a merge-map entry for the dragged app');
    assert.equal(arc._mergeMap.get('appSource'), arc._mergeMap.get('appFocused'));
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
    arc._onCardPress(containerA, groupA, { get_button: () => 1 });
    arc._onDragMotion({ get_coords: () => [50, 240] });
    const origGetPointer = global.get_pointer;
    global.get_pointer = () => [50, 240]; // release point — inside the panel, near containerB
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
    arc._mergeApps('appA', 'appB');
    const group = { apps: [{ get_id: () => 'appA' }, { get_id: () => 'appB' }], appIds: ['appA', 'appB'] };
    const container = new St.Widget({});
    const stop = arc._onCardPress(container, group, { get_button: () => 3 });
    assert.equal(stop, Clutter.EVENT_STOP);
    assert.equal(arc._mergeMap.size, 0);
});

test('right-click on a single-app card is not consumed (propagates for a normal click)', () => {
    const arc = new ArcSidebar(makeSettings());
    const group = { apps: [{ get_id: () => 'appA' }], appIds: ['appA'] };
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

/* ═══ ArcSidebar — momentum scroll, show/hide, persistent mode ════════ */

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

/* ═══ ArcSidebar — keybindings ══════════════════════════════════════── */

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

/* ═══ ArcSidebar — _panel must not clip distant-but-visible cards ═════ */

test('_panel is not clip_to_allocation — cards beyond relIdx=1 legitimately extend past the nominal one-card-wide panel box', () => {
    // On a real 1920x1080 monitor at scale 1 with default settings, arcR
    // (~503px, derived from workarea height) is more than double panelW
    // (~201px, sized for one card) — a card's x drifts by arcR*(1-cos(angle))
    // as it moves off-center, which already exceeds panelW by relIdx=2-3,
    // well before the angle-based MAX_ANGLE cull would hide it. If the panel
    // clips its own allocation, those still-visible-per-the-cull cards render
    // as partial slivers or vanish entirely — this is what actually happened
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

/* ── report ──────────────────────────────────────────────────────────── */

let failed = 0;
for (const [status, name, msg] of results) {
    if (status === 'FAIL') { failed++; console.log(`FAIL  ${name}\n      → ${msg}`); }
    else console.log(`pass  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passing`);
process.exit(failed ? 1 : 0);
