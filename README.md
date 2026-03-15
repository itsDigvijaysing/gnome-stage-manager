# Stage Manager for GNOME

A macOS Stage Manager-like window management extension for GNOME Shell.

Brings the Stage Manager experience to Linux — inactive windows appear as stacked thumbnail cards in a left-side strip, while the active window stays front and center. Switching between stages uses smooth slide-and-scale animations.

## Features

- **Stage Strip** — Left-side strip showing stacked, live thumbnails of inactive workspaces (up to 6), sorted by most recently used
- **Maximize to Workspace** — Maximized windows automatically move to a new, dedicated workspace (their own "stage"); windows stay on their workspace when unmaximized
- **macOS-like Animations** — Smooth slide + scale transitions with cubic easing and staggered timing when switching stages
- **Hover Preview** — Hover over a stage entry to see an enlarged live preview of the top window with app name
- **Auto-hide Strip** — Strip hides automatically when not in use; reveal it by moving the mouse to the left screen edge
- **Fullscreen Aware** — Strip instantly hides when any window goes fullscreen (no flickering)
- **Live Previews** — Thumbnails are real-time Clutter clones, not static screenshots
- **Stacked Cards** — Workspaces with multiple windows show overlapping card-style previews with depth
- **Glassmorphism Design** — Frosted glass panel with subtle shadows and smooth hover states
- **App Icons** — Each stage entry shows app icons and names with window counts
- **Keyboard Accessible** — Strip entries are focusable and activate with Enter/Space
- **Configurable** — Adjust strip width, animation speed, auto-hide delay, edge trigger width, and more

## Requirements

- GNOME Shell 45, 46, 47, or 48
- Wayland or X11
- Debian/Ubuntu or any GNOME-based Linux distribution

## Installation

### From GNOME Extensions Manager

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
git clone https://github.com/gnome-stage-manager/gnome-stage-manager.git
cd gnome-stage-manager
make install
```

Then **log out and log back in** (required on Wayland).

### Enable the Extension

After logging back in:

```bash
gnome-extensions enable stage-manager@gnome-stage-manager
```

Or use the **Extension Manager** app or **GNOME Extensions** app to toggle it on.

### Debian Package

```bash
sudo apt install debhelper libglib2.0-dev
make deb
sudo dpkg -i ../gnome-shell-extension-stage-manager_1.0.0_all.deb
```

## Configuration

Open the extension preferences via:

```bash
gnome-extensions prefs stage-manager@gnome-stage-manager
```

Or click the gear icon in Extension Manager.

### General Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Enable Maximize to Workspace | On | Maximized windows get their own workspace |
| Enable Stage Sidebar | On | Show the left-side stage strip |
| Auto-hide Sidebar | On | Hide strip when not hovering |
| Show Application Icons | On | Display app icons below thumbnails |

### Appearance Settings

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| Sidebar Width | 220px | 120-400 | Width of the stage strip |
| Edge Trigger Width | 4px | 1-20 | Width of the invisible hot zone |
| Animation Duration | 250ms | 0-1000 | Speed of slide animations |
| Auto-hide Delay | 800ms | 100-5000 | Delay before hiding the strip |

## How It Works

Each GNOME workspace is treated as a "stage":

1. **Active stage** — The current workspace. Its windows are visible and interactive.
2. **Inactive stages** — Other workspaces with windows. Shown as stacked thumbnail cards in the left strip.
3. **Switching** — Click a strip entry to switch stages. Current windows slide left and shrink; new windows slide in from the right.
4. **Maximize to workspace** — When you maximize a window, it automatically moves to a new empty workspace, creating a focused stage.

## Uninstall

```bash
make uninstall
```

Or disable/remove via Extension Manager.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
