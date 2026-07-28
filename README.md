# Stage Manager for GNOME

A macOS Stage Manager-like window management extension for GNOME Shell.

Group windows into stages — only one group is visible at a time, others appear as stacked thumbnail cards in a left sidebar. Click a card to swap stages. Supports per-app mode, workspace mode, bell-curve hover animations, and 3D perspective.

![Stage Manager Sidebar](assets/sidebar.png)

## Features

- **Stage Manager Groups** — Windows you use together stay grouped. Only the active group is visible; inactive groups appear as stacked thumbnail cards in a left sidebar.
- **One-Click Swap** — Click any sidebar card to swap stages: the active group minimizes, the clicked group comes to the foreground.
- **3 Sidebar Modes** — Groups (Stage Manager swap), Apps (per-app focus), Workspaces (switch workspaces).
- **Maximize to Workspace** — Optionally move maximized windows to their own workspace (disabled by default).
- **Bell-Curve Hover Animation** — Hovered card scales up smoothly; only 1-2 neighbors are affected (tight sigma).
- **3D Perspective** — Cards have a configurable Y-axis rotation for a natural depth look, consistent direction for all cards.
- **Stacked Thumbnails** — Groups with multiple windows show fanned-out card stacks with visible back layers, scaled so the stack always fits the sidebar.
- **Window Count Badge** — Optional badge showing how many windows are in each group.
- **Live Previews** — Hover a card to see a larger preview of all windows in the group, tiled vertically.
- **Icon Fallback** — Minimized windows that can't be cloned show app icon grids instead.
- **Transparent Sidebar** — No dark bar; each card has its own frosted-glass pill background, and the empty space around the cards passes clicks straight through to the window underneath.
- **Adaptive Cards** — Thumbnails take their size from the sidebar width and their shape from the window they show, so they fit any display density and any window aspect.
- **Auto-hide** — Off by default (macOS behavior: always visible). Toggle on for hover-to-reveal.
- **Fullscreen Aware** — Sidebar hides instantly when any window goes fullscreen.
- **App Icons** — Each card shows app icons below the thumbnail.
- **Configurable** — Sidebar width, animation speed, perspective angle, card scale, auto-hide delay, and more.

![Stage Manager Settings](assets/settings.png)

## Screenshots

![Sidebar with multiple stages](assets/sidebar.png)

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
make test      # offline logic tests (needs node) — see tests/README.md
make pack      # build dist/<uuid>.shell-extension.zip for extensions.gnome.org
make pot       # regenerate po/stage-manager.pot after changing any UI string
```

Translations are welcome — start from `po/stage-manager.pot` and drop the
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
| Enable Maximize to Workspace | Off | Maximized windows get their own workspace |
| Enable Stage Sidebar | On | Show the left-side sidebar |
| Sidebar Content | Groups | Groups (Stage Manager), Apps (per-app focus), or Workspaces |
| Auto-hide Sidebar | Off | Off = always visible (macOS default). On = hover to reveal |
| Reserve Space for Sidebar | Off | Maximized windows stop at the sidebar instead of being covered (needs auto-hide off) |
| Show App Icons | On | Display app icons below thumbnails |
| Show Window Count Badge | On | Show number of windows on group thumbnails |
| Show Current Workspace | On | In workspace mode, also show the current workspace card |

### Appearance

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| Sidebar Width | 220px | 120-400 | Width of the sidebar |
| Edge Trigger Width | 4px | 1-20 | Hot zone at screen edge (pixels) |
| Card Base Scale | 70% | 40-100 | Default card size percentage |
| Perspective Angle | 22° | 0-45 | 3D Y-axis rotation (0 = flat) |
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

## Debugging

Check extension logs:

```bash
journalctl --user -b -g stage-manager
```

Or use the **About** tab in the extension preferences, which has a built-in log viewer.

## Uninstall

```bash
make uninstall
```

Or disable/remove via Extension Manager.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
