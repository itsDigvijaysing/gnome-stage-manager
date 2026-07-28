/**
 * Regression tests for the defects fixed in v1.4.0. Each was written to FAIL
 * against the code before its fix.
 *
 * Run: make test   (or: node tests/build.mjs && node tests/run.mjs)
 */
import assert from 'node:assert/strict';
import {
    Meta, St, clock, wsm, windowManager,
    FakeWindow, makeWindowActor, makeSettings, installGlobals, deliver, resetHarness,
} from './stubs.mjs';

installGlobals();

const { MaximizeToWorkspace, StageSidebar } = await import('./ext-under-test.mjs');

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

/* ═══ #9 — teardown must be total even if a disconnect throws ════════ */

test('#9 disable() completes teardown even when a disconnect throws', () => {
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

    // A finalised GObject: disconnect throws, exactly as during shell shutdown.
    sidebar._sigs.push({ o: { disconnect() { throw new Error('instance not owned'); } }, i: 1 });
    sidebar._cardSigs.push({ o: { disconnect() { throw new Error('instance not owned'); } }, i: 2 });

    sidebar.disable();

    assert.deepEqual(destroyed.sort(), ['box', 'edge', 'panel', 'scroll'],
        'teardown aborted midway — chrome actors left on screen');
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

/* ── report ──────────────────────────────────────────────────────────── */

let failed = 0;
for (const [status, name, msg] of results) {
    if (status === 'FAIL') { failed++; console.log(`FAIL  ${name}\n      → ${msg}`); }
    else console.log(`pass  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passing`);
process.exit(failed ? 1 : 0);
