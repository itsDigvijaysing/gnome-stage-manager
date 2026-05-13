# Stage Manager v1.3.0 — Design

**Date:** 2026-05-13
**Status:** Approved (pending user spec review)
**Target release:** `stage-manager@gnome-stage-manager` v1.3.0

## Goal

Ship a polished v1.3.0 release of the Stage Manager extension that:

1. Loads cleanly on Ubuntu 26.04 LTS (GNOME Shell 50.x, Wayland) — the
   current `metadata.json` declares only `["45","46","47","48"]` and is
   therefore refused by the host shell.
2. Honors the unmaximize-restores-workspace promise that the README and
   gschema description make but the code never delivered.
3. Looks and behaves correctly on HiDPI displays, with light/dark theme,
   and across multi-monitor setups.
4. Adds keyboard-shortcut plumbing for the sidebar toggle (no default
   binding — user opts in).
5. Stays compliant with the `shexli` rules documented in `CLAUDE.md`
   (EGO-L-002, L-003, L-004, L-007, P-006).

## Non-goals

Explicitly out of scope for v1.3:

- File/module split of `extension.js` (~1200 LOC stays single-file).
- Drag-to-reorder cards.
- Manual group splitting / merging UI.
- Per-app ignore-lists.
- A default keybinding (user must set their own in prefs).
- JSDoc type annotations sweep.

## High-level approach

Single coordinated v1.3.0 release, structured as separate commits but
shipped together. Each section below maps to roughly one commit.

## Section 1 — Compatibility & version bookkeeping

### 1.1 Shell-version expansion

`src/metadata.json` currently:

```json
"shell-version": ["45", "46", "47", "48"]
```

Change to:

```json
"shell-version": ["45", "46", "47", "48", "49", "50"]
```

Without `49` and `50`, GNOME Shell 50.1 (Ubuntu 26.04) refuses to load
the extension at all — this is the most user-visible bug in v1.0.

### 1.2 Version field

EGO uses an integer `version` field (auto-incremented at upload) and
optionally a `version-name` string. Add to `metadata.json`:

```json
"version-name": "1.3.0"
```

(Do not add `version` manually — EGO assigns it. Local installs do not
require it.)

### 1.3 Version strings

- `src/prefs.js` line 146: `subtitle: '1.0.0'` → `'1.3.0'`.
- `debian/changelog`: prepend a new `1.3.0` entry summarizing the
  release. Date format: RFC 5322 (`Wed, 13 May 2026 ...`).
- `debian/control`: replace placeholder `Maintainer:
  Stage Manager Contributors <stage-manager@example.com>` with
  `Digvijaysing <lightspeakai@gmail.com>` (per the GitHub repo owner
  `itsdigvijaysing` and the user email on file). If the user prefers a
  different address, this is a one-line edit at implementation time.

## Section 2 — Bug: return-on-unmaximize

### 2.1 Current behavior

`MaximizeToWorkspace._onSize()` only handles `Meta.SizeChange.MAXIMIZE`.
On unmaximize, the window stays on the new workspace it was moved to.

The README and the gschema description for `enable-maximize-to-workspace`
both promise: *"When unmaximized, return it to the previous workspace."*
This is a documented-but-unimplemented feature.

### 2.2 New behavior

Track each auto-moved window's origin workspace in a `Map<MetaWindow,
number>`. On unmaximize, restore.

Skeleton:

```js
class MaximizeToWorkspace {
    constructor(settings) {
        this._settings = settings;
        this._sigs = [];
        this._timers = [];
        this._moved = new Set();          // existing: prevents re-trigger loop
        this._origin = new Map();         // NEW: window → origin workspace index
    }

    enable() {
        this._sig(global.window_manager, 'size-change',
            (_wm, actor, change) => this._onSize(actor, change));
        this._sig(global.window_manager, 'destroy', (_wm, actor) => {
            try {
                if (actor.meta_window) {
                    this._moved.delete(actor.meta_window);
                    this._origin.delete(actor.meta_window);
                }
            } catch (_) { /* */ }
        });
    }

    disable() {
        this._sigs.splice(0).forEach(s => { try { s.o.disconnect(s.i); } catch (_) { /* */ } });
        this._timers.splice(0).forEach(id => GLib.source_remove(id));
        this._moved.clear();
        this._origin.clear();
    }

    _onSize(actor, change) {
        if (!this._settings.get_boolean('enable-maximize-to-workspace')) return;
        const win = actor.meta_window;
        if (!win || !_isNormal(win)) return;

        if (change === Meta.SizeChange.MAXIMIZE) {
            this._handleMaximize(win);
        } else if (change === Meta.SizeChange.UNMAXIMIZE) {
            this._handleUnmaximize(win);
        }
    }
    // ... _handleMaximize is the existing logic, but also stores
    //     this._origin.set(win, ci) before the move.
    // ... _handleUnmaximize looks up origin, validates the workspace
    //     still exists, moves back, deletes from both maps.
}
```

### 2.3 Edge cases

- **Origin workspace removed**: if `wsm.get_workspace_by_index(origin)`
  returns null, no-op (don't crash). Just delete the map entry.
- **Window destroyed mid-move**: `_handleUnmaximize` is called inside a
  signal handler; window is still alive at this point. Cleanup happens
  via the existing `destroy` signal hook.
- **User manually moved the window between max and unmax**: still
  restore to origin — that matches the documented contract. (Could be
  refined later but not in v1.3.)
- **`_moved` flag**: must be deleted in `_handleUnmaximize` after the
  move-back, otherwise re-maximizing won't trigger again.

## Section 3 — GNOME 47-50 API verification

The host machine runs GNOME Shell 50.1 Wayland. Each shell API used
must be confirmed working. None are currently believed to be removed,
but a verification step is required:

| API | Used at | Status |
|---|---|---|
| `Main.layoutManager.addChrome` / `removeChrome` | edge, panel, preview | Stable 45-50 |
| `St.ScrollView.set_child` | scroll → box | Stable 45-50 |
| `event.get_scroll_delta()` | scroll-event | Stable but may return `[0,0]` for non-smooth scroll devices — add fallback to `get_scroll_direction()` |
| `St.PolicyType.NEVER` | scroll policy | Stable |
| `Clutter.AnimationMode.EASE_OUT_*` | animations | Stable |
| `actor.ease(...)` | animations | Stable |
| `Main.wm.addKeybinding` | NEW for keybinding | Stable 45-50 |
| `St.ThemeContext.get_for_stage` | NEW for HiDPI | Stable 45-50 |
| `Main.layoutManager.connect('monitors-changed')` | NEW for multi-monitor | Stable 45-50 |
| `Shell.WindowTracker.get_default()` | app lookups | Stable |

Verification step (manual, post-implementation):

```bash
make install
# log out / log back in
journalctl --user -f -o cat /usr/bin/gnome-shell &
gnome-extensions disable stage-manager@gnome-stage-manager
gnome-extensions enable stage-manager@gnome-stage-manager
# expect zero JS ERROR lines
```

## Section 4 — Polish: HiDPI, theme, multi-monitor

### 4.1 HiDPI scaling

Constants `THUMB_W=170`, `THUMB_H=110`, `ICON_SIZE=22`, `STACK_H=14`,
`STACK_V=4` are pixel literals. On a 200% HiDPI display the cards render
half the intended size.

Read scale factor in `_build()`:

```js
const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
const thumbW = THUMB_W * scaleFactor;
// ...
```

Listen for `notify::scale-factor` on the theme context and trigger a
`_refresh()` on change. Track the signal via `_sig()` (it's connected
to a long-lived global object — disconnect in `disable()`).

### 4.2 Theme-aware CSS

Currently every visual style is inline:

```js
style: 'padding: 8px 14px; border-radius: 16px; background-color: rgba(28,28,34,0.55);'
```

The hardcoded dark color clashes with light theme. Move static colors
into a stylesheet that uses GNOME's theme variables.

**New file:** `src/stylesheet.css`

```css
.stage-card {
    padding: 8px 14px;
    border-radius: 16px;
    background-color: rgba(28, 28, 34, 0.55);
}

.stage-card:hover {
    background-color: rgba(45, 45, 55, 0.7);
}

.stage-card-thumb-layer {
    border-radius: 12px;
    background-color: rgba(30, 30, 34, 0.6);
}

.stage-card-thumb-layer-front-hover {
    background-color: rgba(50, 50, 58, 0.75);
    box-shadow: 0 4px 20px rgba(120, 140, 255, 0.18);
}

.stage-preview {
    background-color: rgba(22, 22, 26, 0.94);
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55);
}

.stage-badge {
    background-color: rgba(100, 120, 220, 0.85);
    color: white;
    border-radius: 9px;
    padding: 1px 7px;
    font-size: 10px;
    font-weight: bold;
}

/* Light theme variants — GNOME exposes the user's color scheme via
 * the stage's style class when Adwaita's color-scheme switch is set. */
.stage-card.light {
    background-color: rgba(255, 255, 255, 0.6);
    color: #1a1a1a;
}
/* ... etc. */
```

GNOME Shell 45+ auto-loads `stylesheet.css` from the extension root.
Replace inline `style:` in `extension.js` with `style_class:` references
where the values are static. Inline styles remain only for *dynamic*
values (perspective angle interpolation, dynamic opacities).

For light/dark detection, check `St.Settings.get().color_scheme` (added
in 47); if `PREFER_LIGHT`, add a `.light` style class to cards. Also
listen for `notify::color-scheme` to swap classes live.

### 4.3 Multi-monitor

`_build()` reads `Main.layoutManager.primaryMonitor` once. If the user
plugs in/unplugs a monitor or changes which is primary, the sidebar
stays on the old (possibly disconnected) monitor.

Listen for `monitors-changed` on `Main.layoutManager`:

```js
this._sig(Main.layoutManager, 'monitors-changed', () => this._rebuildLayout());
```

Where `_rebuildLayout()` reads new `primaryMonitor`, repositions
`_panel` and `_edge`, and rebuilds the panel size. No card-level
rebuild needed — only positions.

(Picking which monitor in prefs is intentionally deferred — primary
monitor is the standard and adding a monitor-picker UI for v1.3 is
scope creep.)

## Section 5 — Keyboard shortcut plumbing (no default)

### 5.1 Schema

Add to `org.gnome.shell.extensions.stage-manager.gschema.xml`:

```xml
<key name="toggle-sidebar" type="as">
    <default><![CDATA[[]]]></default>
    <summary>Toggle Sidebar Shortcut</summary>
    <description>Keyboard shortcut to toggle the stage sidebar
    visibility. Empty array means no shortcut is bound.</description>
</key>
```

Type `as` (array of strings) is GNOME's standard for keybindings.
Default empty — user must set explicitly in prefs.

### 5.2 Extension wiring

In `StageSidebar.enable()`:

```js
Main.wm.addKeybinding(
    'toggle-sidebar',
    this._settings,
    Meta.KeyBindingFlags.NONE,
    Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
    () => this._toggleVisible(),
);
```

In `disable()`:

```js
Main.wm.removeKeybinding('toggle-sidebar');
```

`_toggleVisible()` is a small helper: if `_visible` then `_hide()` else
`_show()`.

### 5.3 Prefs UI

In `prefs.js`, add a new "Shortcuts" group on the Behavior page with
one row showing the current binding and a "Set shortcut" button.

Use `Adw.ShortcutLabel` to display the current accel (or "Disabled" if
empty), and a `Gtk.Button` whose `clicked` handler opens a modal that
captures the next key combo via `Gtk.EventControllerKey`. Clear button
to reset.

This is a small but real chunk of UI code (~60 lines). Acceptable
because the user explicitly asked for it.

## Section 6 — Code hygiene (light)

- **Remove dead code**: `StageSidebar._disconnectAllSigs()` is defined
  but never called. The inline `.splice(0).forEach(...)` in `disable()`
  does the same thing. Delete the unused method.
- **Leave deliberate duplicates**: per CLAUDE.md, the inline arrow `sig`
  in `_wire()` duplicating `this._sig` is intentional — do not touch.
- **No file split**, no JSDoc sweep, no rename.

## Section 7 — Verification & packaging

### 7.1 EGO compliance checks

Before tagging the release:

- `make pack && unzip -l dist/*.zip | grep -E '\.compiled$'` must produce
  no output (CLAUDE.md Rule 5 / EGO-P-006).
- Every new `obj.connect(...)` call routes through `_sig()`,
  `_cardSig()`, or `_setSigs.push(this._settings.connect(...))`
  (EGO-L-003).
- Every new `GLib.timeout_add(...)` is paired with `_kill('_field')`
  before re-arming (EGO-L-004 / L-007).
- Every new actor created in `enable()` has an explicit `.destroy()` in
  `disable()` (EGO-L-002).

### 7.2 Manual smoke test

```bash
make install
# log out, log back in
journalctl --user -f -o cat /usr/bin/gnome-shell  # in second terminal
```

For each of:
- Sidebar toggle on/off via prefs
- Mode switch: groups → apps → workspaces (via dropdown)
- Open + close several windows; verify card refresh
- Hover cards; verify bell-curve scale + preview
- Click cards in groups mode; verify swap
- Maximize a window with maximize-to-workspace enabled; verify it moves
- **Unmaximize the same window; verify it returns to origin**
- Plug/unplug a second monitor; verify sidebar repositions
- Switch system theme light ↔ dark; verify CSS adapts
- Set a keyboard shortcut in prefs; verify it toggles the sidebar
- `gnome-extensions disable` then `enable`; verify zero `JS ERROR` in
  the journal

## Files touched

| File | Change |
|---|---|
| `src/metadata.json` | shell-version 49+50, version-name |
| `src/extension.js` | unmaximize fix, HiDPI, stylesheet refactor, multi-monitor signal, keybinding, dead code removal |
| `src/prefs.js` | version string, shortcuts group |
| `src/schemas/org.gnome.shell.extensions.stage-manager.gschema.xml` | toggle-sidebar key |
| `src/stylesheet.css` | **new file** |
| `debian/changelog` | 1.3.0 entry |
| `debian/control` | maintainer email |
| `README.md` | minor — version bumps if any inline |

## Risks

- **Theme detection edge cases**: not all GNOME themes expose
  `St.Settings.color_scheme` (e.g. third-party themes may report
  `DEFAULT`). Mitigation: dark theme is default; light is opt-in via
  the user's GNOME setting.
- **Keybinding collision**: since the default is empty, no collision
  ships. User responsible for picking an unused combo.
- **Multi-monitor edge cases**: monitor unplug while sidebar visible
  — `_rebuildLayout` will reposition; if the new primary is smaller,
  panel may need its height recalculated. Tested via simulated
  hot-plug.
- **GNOME 51+ (future)**: not targeted; we only test 50.

## Acceptance criteria

1. `metadata.json` lists shell-version 45-50 inclusive.
2. Extension loads on GNOME 50.1 Wayland with no `JS ERROR` in the
   journal during enable, disable, or re-enable.
3. Maximize-to-workspace round-trip: maximize a window → it moves to a
   new workspace; unmaximize → it returns to the original workspace.
4. Cards render at correct size on HiDPI (verified by changing scale
   factor and observing rebuild).
5. Cards visually adapt to light vs dark GNOME theme.
6. Sidebar repositions when monitors are added/removed.
7. Setting a keyboard shortcut in prefs and pressing it toggles the
   sidebar visibility.
8. `make pack` produces a zip with no `.compiled` files.
9. Version "1.3.0" appears consistently in metadata, prefs About tab,
   and debian/changelog.
