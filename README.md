# Stage Manager for Linux

A macOS Stage Manager-like window management extension for GNOME Shell.

Group windows into stages: only one group is visible at a time, others appear as stacked thumbnail cards in a sidebar at the screen edge. Click a card to swap stages. Supports per-app mode, workspace mode, bell-curve hover animations, and 3D perspective.

- Demo: https://youtu.be/8fnFvYaxUMo
- GNOME Extensions: https://extensions.gnome.org/extension/9528/stage-manager/
- GitHub: https://github.com/itsDigvijaysing/gnome-stage-manager

![Stage Manager Sidebar](assets/sidebar.png)

## Features

- **Stage Manager Groups**: Windows you use together stay grouped. Only the active group is visible; inactive groups appear as stacked thumbnail cards in a sidebar (left, right, or a bottom strip).
- **One-Click Swap**: Click any sidebar card to swap stages. The active group minimizes, the clicked group comes to the foreground.
- **4 Sidebar Modes**: Groups (Stage Manager swap), Apps (per-app focus), Workspaces (switch workspaces), All Windows (every window on every workspace).
- **Arc Layout**: An alternate sidebar built as a stacked-paper carousel on the left, right, or bottom edge, with hover-to-fan reveal, momentum scrolling, drag-to-merge (drop a card outside the carousel to merge it into the focused app) and drag-to-reorder (drop inside), right-click to un-merge, an optional persistent mode, and its own keyboard shortcuts.
- **Drag-to-Merge Apps**: In Apps mode (stack layout), drag one app card onto another to combine them into a single card; right-click a merged card to split it back apart. Independent of Arc Layout's own merge system.
- **Keyboard Shortcut**: Optional shortcut to reveal/hide the sidebar without moving the mouse to the screen edge. Set it in Preferences → Behavior → Shortcuts; it applies immediately.
- **Maximize Behaviour**: What maximizing a window does. Options are nothing (default), move it to a new empty workspace, or give it a stage of its own with its former stage-mates parked as a card (Stack layout + Groups mode). Unmaximizing always returns the window.
- **Bell-Curve Hover Animation**: Hovered card scales up smoothly; only 1-2 neighbors are affected (tight sigma).
- **3D Perspective**: Cards have a configurable Y-axis rotation for a natural depth look, consistent direction for all cards.
- **Stacked Thumbnails**: Groups with multiple windows show fanned-out card stacks with visible back layers, scaled so the stack always fits the sidebar.
- **Window Count Badge**: Optional badge showing how many windows are in each group.
- **Live Previews**: Hover a card to see a larger preview of all windows in the group, tiled vertically.
- **Icon Fallback**: Minimized windows that can't be cloned show app icon grids instead.
- **Transparent Sidebar**: No dark bar; each card has its own frosted-glass pill background, and the space beside the card column passes clicks straight through to the window underneath (gaps between cards stay part of the column, so it can scroll). A window that covers the sidebar makes it step aside.
- **Adaptive Cards**: Thumbnails take their size from the sidebar width and their shape from the window they show, so they fit any display density and any window aspect.
- **Auto-hide**: Off by default (macOS behavior). The sidebar stays up, but steps aside while a window covers its area so that window stays fully clickable; move the pointer to the screen edge to bring it back. Toggle auto-hide on for hover-to-reveal only.
- **Click the Desktop**: In Groups mode, clicking the empty desktop parks the current stage as one card, like clicking the wallpaper on macOS.
- **Stages Stay Whole**: Restoring a window from the dock or alt-tab brings its whole stage forward instead of pulling that one window out of it.
- **Fullscreen Aware**: Sidebar hides instantly when any window goes fullscreen.
- **App Icons**: Each card shows app icons below the thumbnail.

![Stage Manager Settings](assets/settings.png)

## Screenshots

![The sidebar on its own](assets/sidebar_only.png)

## Requirements

- GNOME Shell 46 through 50 (Ubuntu 26.04 LTS supported)
- Wayland or X11

## Installation

### From GNOME Extensions

1. Visit [extensions.gnome.org](https://extensions.gnome.org/) and search for **Stage Manager**
2. Toggle the switch to install

### From Extension Manager App

1. Open **Extension Manager** (install from Flathub if needed)
2. Search for "Stage Manager"
3. Click Install

### From Zip File

```bash
make pack
gnome-extensions install dist/stage-manager@gnome-stage-manager.shell-extension.zip
```

Then **log out and log back in** (required on Wayland).

### From Source

```bash
git clone https://github.com/itsdigvijaysing/gnome-stage-manager.git
cd gnome-stage-manager
make install
```

Then **log out and log back in** (required on Wayland).

### Enable the Extension

```bash
gnome-extensions enable stage-manager@gnome-stage-manager
```

Or use the **Extension Manager** app to toggle it on.

## Development

```bash
make test      # offline logic tests (needs node); see tests/README.md
make pack      # build dist/<uuid>.shell-extension.zip for extensions.gnome.org
make pot       # regenerate po/stage-manager.pot after changing any UI string
```

Translations are welcome: start from `po/stage-manager.pot` and drop the
resulting `.po` into a pull request.

## Configuration

Open preferences via:

```bash
gnome-extensions prefs stage-manager@gnome-stage-manager
```

Or click the gear icon in Extension Manager.

### Behavior

| Setting | Default | Description |
|---------|---------|-------------|
| When a Window Is Maximized | Do nothing | Do nothing, move it to a new workspace, or give it its own stage (Stack layout + Groups mode) |
| Sidebar Content | Groups | Groups (Stage Manager), Apps (per-app focus), Workspaces, or All Windows |
| Auto-hide Sidebar | Off | Off = shown, stepping aside when a window covers it (macOS default). On = hover to reveal |
| Hide When a Window Covers It | On | The sidebar slides out while a window sits under it, so that window stays clickable (Stack; no effect with Reserve Space on) |
| Park Stage on Desktop Click | On | Clicking the empty desktop minimizes the current stage into one card (Stack, Groups mode) |
| Reserve Space for Sidebar | Off | Maximized windows stop at the sidebar instead of being covered (needs auto-hide off) |
| Show App Icons | On | Display app icons below thumbnails |
| Show Window Count Badge | On | Show number of windows on group thumbnails |
| Show Current Workspace | On | In workspace mode, also show the current workspace card |
| Sidebar Layout | Stack | Stack (vertical list) or Arc (full carousel, see below) |
| Stack Panel Position | Left | Screen edge the Stack sidebar attaches to: Left, Right, or Bottom (a horizontal strip) |
| Arc Panel Position | Left | Screen edge the Arc carousel attaches to: Left, Right, or Bottom |
| Persistent Mode (Arc) | Off | Keep the Arc carousel shown whenever no window overlaps its area |

### Appearance

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| Sidebar Width | 220px | 120-400 | Thickness of the sidebar: its width on a side edge, its height on the bottom |
| Edge Trigger Width | 4px | 1-20 | Hot zone at screen edge (pixels) |
| Edge Trigger Delay | 250ms | 0-1000 | How long the pointer must rest on the edge before the sidebar opens (0 = instant) |
| Arc Angle Step | 16° | 8-30 | Degrees between adjacent cards in Arc layout |
| Card Base Scale | 70% | 40-100 | Default card size percentage |
| Perspective Angle | 22° | 0-45 | 3D Y-axis rotation (0 = flat) |
| Arc Card Scale | 100% | 50-150 | Card size percentage in Arc layout |
| Arc Scroll Speed | 10 | 1-20 | Momentum-scroll speed in Arc layout |
| Animation Duration | 250ms | 0-1000 | Slide animation speed |
| Hide Delay | 800ms | 100-5000 | Delay before hiding after mouse leaves |

## How It Works

### Groups Mode (default)

1. All visible windows on the current workspace form the **active group**.
2. When you manually minimize a window, it splits into its own **inactive group** in the sidebar.
3. Click a sidebar card to **swap**: the active group minimizes, the target group unminimizes and comes to the foreground.
4. New windows join the active group **of the workspace they open on**.

Stages are **per workspace**, like Stage Manager's own per-Space behaviour: each
workspace keeps its own arrangement, and switching away and back leaves it
intact. A window you drag to another workspace moves to that workspace's stages.

### Apps Mode

Windows are grouped by application. Click a sidebar card to focus that app's windows.

### Workspaces Mode

Each workspace is shown as a sidebar card. Click to switch workspaces.

### All Windows Mode

Every open window on every workspace gets its own card, grouped under a workspace
heading, including minimized windows, which are otherwise unreachable without
switching workspaces first. The window you are currently focused on is left out,
since it is already in front of you.

Clicking a card just activates that window; GNOME switches to its workspace for
you. This mode never minimizes, regroups or moves anything, so your stages are
left exactly as they were.

### Arc Layout Mode

Switch **Sidebar Layout** to **Arc** for a completely different sidebar
experience: a stacked-paper carousel, not a repositioned version of the stack
layout. It groups by application unconditionally (the **Sidebar Content**
setting only applies to Stack layout) and has its own independent state:

- **Position**: attaches to the left, right, or bottom edge (**Arc Panel
  Position**), unlike Stack layout which is always left-edge.
- **Hover to fan**: hold the pointer over a multi-window card briefly and its
  windows fan out into individual cards; move away and they collapse back into
  a stack.
- **Momentum scroll**: the wheel gives the carousel velocity that decays
  naturally, rather than jumping straight to a position.
- **Drag to merge or reorder**: press and drag a card past a small threshold:
  drop it **outside** the carousel to merge it into whichever app currently has
  focus (combining their windows under one card), or drop it **inside** the
  carousel to reorder it. Right-click a merged card to split it back apart.
  This is a separate merge system from Apps mode's card-onto-card merge above
  (the two don't share state, and switching layouts with one active doesn't
  affect the other).
- **Persistent Mode**: when enabled, the carousel stays shown any time no
  window overlaps its area, instead of only appearing on hover.
- **Keyboard shortcuts**: independent Next/Previous/Activate/Close shortcuts
  for the carousel, set under **Preferences → Behavior → Shortcuts**, in
  addition to the shared Toggle Sidebar shortcut below.

### Keyboard Shortcut

No shortcut is bound by default. Set one under **Preferences → Behavior →
Shortcuts → Toggle Sidebar** and it takes effect immediately, with no restart or
re-login needed. Useful with *Auto-hide Sidebar* on, so the sidebar appears on a
keypress instead of a mouse trip to the screen edge.

## Debugging

Check extension logs:

```bash
journalctl --user -b -g stage-manager
```

Or use the **About** tab in the extension preferences, which has a built-in log viewer.

## Known Issues

- [ ] Improve Arc Mode for Better Hover & App Selection
- [ ] Merge Both Modes and have core Appearance Section
- [ ] Empty System App Appears if no window is Open

## Uninstall

```bash
make uninstall
```

Or disable/remove via Extension Manager.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
