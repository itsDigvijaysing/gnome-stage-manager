/**
 * Stage Manager - Preferences UI
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import * as Config from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';


export default class StageManagerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // ── Behavior Page ──
        const behaviorPage = new Adw.PreferencesPage({
            title: _('Behavior'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(behaviorPage);

        // Sidebar Layout — the single biggest choice in this page, so it gets
        // its own segmented switch at the very top rather than a dropdown
        // buried inside a settings group.
        const layoutGroup = new Adw.PreferencesGroup({
            title: _('Sidebar Layout'),
            description: _('Stack = vertical list of cards (default). Arc = full carousel arrangement.'),
        });
        behaviorPage.add(layoutGroup);

        const layoutBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.CENTER,
            margin_top: 6,
            margin_bottom: 6,
        });
        layoutBox.add_css_class('linked');

        const layoutKeys = ['stack', 'arc'];
        const stackToggle = new Gtk.ToggleButton({ label: _('Stack') });
        const arcToggle = new Gtk.ToggleButton({ label: _('Arc') });
        arcToggle.set_group(stackToggle);
        layoutBox.append(stackToggle);
        layoutBox.append(arcToggle);

        const layoutToggles = [stackToggle, arcToggle];
        const layoutVal = settings.get_string('sidebar-layout');
        layoutToggles[Math.max(0, layoutKeys.indexOf(layoutVal))].set_active(true);
        layoutToggles.forEach((toggle, i) => {
            toggle.connect('notify::active', () => {
                if (toggle.active) settings.set_string('sidebar-layout', layoutKeys[i]);
            });
        });

        const layoutSwitchRow = new Adw.PreferencesRow({ activatable: false });
        layoutSwitchRow.set_child(layoutBox);
        layoutGroup.add(layoutSwitchRow);

        const maxGroup = new Adw.PreferencesGroup({
            title: _('Maximize Behaviour'),
            description: _('What happens when a window is maximized'),
        });
        behaviorPage.add(maxGroup);

        // One enum instead of two switches: the old pair both answered "maximize"
        // and one silently won, so the exclusion is now structural.
        const maxRow = new Adw.ActionRow({
            title: _('When a Window Is Maximized'),
            subtitle: _('Unmaximizing always returns the window, whatever this is set to'),
        });
        const maxKeys = ['none', 'workspace', 'stage'];
        const maxLabels = [
            _('Do nothing'),
            _('Move it to a new workspace'),
            _('Give it its own stage (In Stack Mode)'),
        ];
        const maxDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(maxLabels),
            valign: Gtk.Align.CENTER,
        });
        maxDropdown.set_selected(Math.max(0, maxKeys.indexOf(settings.get_string('maximize-behavior'))));
        maxDropdown.connect('notify::selected', () => {
            settings.set_string('maximize-behavior', maxKeys[maxDropdown.get_selected()] || 'none');
        });
        maxRow.add_suffix(maxDropdown);
        maxGroup.add(maxRow);

        // Stage Sidebar
        const sideGroup = new Adw.PreferencesGroup({
            title: _('Stage Manager Sidebar'),
            description: _('Thumbnail cards for your inactive stages, at the screen edge'),
        });
        behaviorPage.add(sideGroup);

        // Arc always auto-hides (hover-only, no "always visible" mode) and
        // never reserves struts — both rows are Stack-only.
        const autoHideSwitch = new Adw.SwitchRow({
            title: _('Auto-hide Sidebar'),
            subtitle: _('Off = shown, stepping aside when a window covers it (macOS default). On = hover to reveal.'),
        });
        settings.bind('sidebar-auto-hide', autoHideSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        sideGroup.add(autoHideSwitch);
        this._bindLayoutSensitivity(autoHideSwitch, settings, 'stack');

        const reserveSwitch = new Adw.SwitchRow({
            title: _('Reserve Space for Sidebar'),
            subtitle: _('Maximized windows stop at the sidebar instead of being covered. Needs auto-hide off.'),
        });
        settings.bind('sidebar-reserve-space', reserveSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        sideGroup.add(reserveSwitch);
        this._bindLayoutSensitivity(reserveSwitch, settings, 'stack');

        // Sidebar Content — what the Stack layout's cards show. Arc has no
        // equivalent (it always groups by app, one icon per stacked window), so
        // the whole group is hidden rather than shown inert while layout is arc.
        const contentGroup = new Adw.PreferencesGroup({
            title: _('Sidebar Content'),
            description: _('Stack layout only'),
        });
        behaviorPage.add(contentGroup);
        this._bindLayoutVisibility(contentGroup, settings, 'stack');

        const modeRow = new Adw.ActionRow({
            title: _('Card Grouping'),
            subtitle: _('Groups = Stage Manager (swap), Apps = per-app (focus), Workspaces, All Windows'),
        });
        const modeKeys = ['groups', 'apps', 'workspaces', 'all-windows'];
        const modeLabels = [
            _('Groups (Stage Manager)'),
            _('Apps (per-app focus)'),
            _('Workspaces'),
            _('All Windows (every workspace)'),
        ];
        const modeDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(modeLabels),
            valign: Gtk.Align.CENTER,
        });
        // Sync setting → dropdown
        const modeVal = settings.get_string('sidebar-mode');
        modeDropdown.set_selected(Math.max(0, modeKeys.indexOf(modeVal)));
        // Sync dropdown → setting
        modeDropdown.connect('notify::selected', () => {
            const sel = modeDropdown.get_selected();
            settings.set_string('sidebar-mode', modeKeys[sel] || 'groups');
        });
        modeRow.add_suffix(modeDropdown);
        contentGroup.add(modeRow);

        const iconSwitch = new Adw.SwitchRow({
            title: _('Show App Icons'),
            subtitle: _('Display app icon below each thumbnail'),
        });
        settings.bind('show-app-icons', iconSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        contentGroup.add(iconSwitch);

        const groupCountSwitch = new Adw.SwitchRow({
            title: _('Show Window Count Badge'),
            subtitle: _('Show number of windows on group thumbnails'),
        });
        settings.bind('show-group-count', groupCountSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        contentGroup.add(groupCountSwitch);

        const showCurrentWsSwitch = new Adw.SwitchRow({
            title: _('Show Current Workspace'),
            subtitle: _('In workspace mode, also show the current workspace card'),
        });
        settings.bind('show-workspace-current', showCurrentWsSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        contentGroup.add(showCurrentWsSwitch);

        // Smart Visibility
        const smartGroup = new Adw.PreferencesGroup({
            title: _('Smart Visibility'),
            description: _('Automatically show the sidebar based on desktop state'),
        });
        behaviorPage.add(smartGroup);

        const emptyWsSwitch = new Adw.SwitchRow({
            title: _('Show on Empty Desktop'),
            subtitle: _('Always show sidebar when all windows on the current workspace are minimized'),
        });
        settings.bind('show-on-empty-workspace', emptyWsSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        smartGroup.add(emptyWsSwitch);

        // Both Stack-only: Arc has its own persistent mode and never parks stages.
        const coveredSwitch = new Adw.SwitchRow({
            title: _('Hide When a Window Covers It'),
            subtitle: _('The sidebar slides out while a window sits under it, so that window stays clickable. Reveal it from the screen edge.'),
        });
        settings.bind('sidebar-hide-when-covered', coveredSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        smartGroup.add(coveredSwitch);
        this._bindLayoutSensitivity(coveredSwitch, settings, 'stack');

        const desktopClickSwitch = new Adw.SwitchRow({
            title: _('Park Stage on Desktop Click'),
            subtitle: _('Clicking the empty desktop minimizes the current stage into one card (Groups mode)'),
        });
        settings.bind('park-on-desktop-click', desktopClickSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        smartGroup.add(desktopClickSwitch);
        this._bindLayoutSensitivity(desktopClickSwitch, settings, 'stack');

        // Shortcuts
        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: _('No shortcut is set by default. Click Set to choose one — it takes effect immediately, no restart needed.'),
        });
        behaviorPage.add(shortcutGroup);

        this._addShortcutRow(shortcutGroup, settings, 'toggle-sidebar',
            _('Toggle Sidebar'),
            _('Reveal or hide the sidebar without moving the mouse to the screen edge'));
        this._addShortcutRow(shortcutGroup, settings, 'keybinding-show-desktop',
            _('Show Desktop'),
            _('Reveal the wallpaper by parking the current stage or minimizing every window'));
        this._addShortcutRow(shortcutGroup, settings, 'keybinding-arc-next',
            _('Arc: Next Card'), _('Move the arc carousel to the next card'));
        this._addShortcutRow(shortcutGroup, settings, 'keybinding-arc-prev',
            _('Arc: Previous Card'), _('Move the arc carousel to the previous card'));
        this._addShortcutRow(shortcutGroup, settings, 'keybinding-arc-activate',
            _('Arc: Activate Card'), _('Activate the front card of the arc carousel'));
        this._addShortcutRow(shortcutGroup, settings, 'keybinding-arc-close',
            _('Arc: Close Front Window'), _('Close the front window of the arc carousel\'s front card'));

        // ── Appearance Page ──
        const lookPage = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(lookPage);

        const sizeGroup = new Adw.PreferencesGroup({ title: _('Dimensions') });
        lookPage.add(sizeGroup);

        this._addSpinRow(sizeGroup, settings, 'sidebar-width',
            _('Sidebar Width'), _('Width in pixels'), 120, 400, 10);
        this._addSpinRow(sizeGroup, settings, 'edge-trigger-width',
            _('Edge Trigger Width'), _('Hot zone at screen edge (pixels)'), 1, 20, 1);
        this._addSpinRow(sizeGroup, settings, 'edge-trigger-delay',
            _('Edge Trigger Delay'),
            _('Pointer must rest on the edge this long before the sidebar opens (ms, 0 = instant)'),
            0, 1000, 50);

        // Stack Layout — position only applies to the Stack layout; the card
        // list itself stays a vertical column either way (see CLAUDE.md on
        // why Bottom isn't offered here yet).
        const stackGroup = new Adw.PreferencesGroup({
            title: _('Stack Layout'),
            description: _('Stack layout only'),
        });
        lookPage.add(stackGroup);
        this._bindLayoutVisibility(stackGroup, settings, 'stack');

        const stackPosRow = new Adw.ActionRow({
            title: _('Panel Position'),
            subtitle: _('Screen edge the stack sidebar attaches to. Bottom lays the cards out as a horizontal strip.'),
        });
        const stackPosKeys = ['left', 'right', 'bottom'];
        const stackPosLabels = [_('Left'), _('Right'), _('Bottom')];
        const stackPosDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(stackPosLabels),
            valign: Gtk.Align.CENTER,
        });
        const stackPosVal = settings.get_string('stack-panel-position');
        stackPosDropdown.set_selected(Math.max(0, stackPosKeys.indexOf(stackPosVal)));
        stackPosDropdown.connect('notify::selected', () => {
            const sel = stackPosDropdown.get_selected();
            settings.set_string('stack-panel-position', stackPosKeys[sel] || 'left');
        });
        stackPosRow.add_suffix(stackPosDropdown);
        stackGroup.add(stackPosRow);

        // Arc Layout — settings specific to the 'arc' sidebar-layout carousel.
        const arcGroup = new Adw.PreferencesGroup({
            title: _('Arc Layout'),
            description: _('Arc layout only'),
        });
        lookPage.add(arcGroup);
        this._bindLayoutVisibility(arcGroup, settings, 'arc');

        const arcPosRow = new Adw.ActionRow({
            title: _('Panel Position'),
            subtitle: _('Screen edge the arc carousel attaches to'),
        });
        const arcPosKeys = ['left', 'right', 'bottom'];
        const arcPosLabels = [_('Left'), _('Right'), _('Bottom')];
        const arcPosDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(arcPosLabels),
            valign: Gtk.Align.CENTER,
        });
        const arcPosVal = settings.get_string('arc-panel-position');
        arcPosDropdown.set_selected(Math.max(0, arcPosKeys.indexOf(arcPosVal)));
        arcPosDropdown.connect('notify::selected', () => {
            const sel = arcPosDropdown.get_selected();
            settings.set_string('arc-panel-position', arcPosKeys[sel] || 'left');
        });
        arcPosRow.add_suffix(arcPosDropdown);
        arcGroup.add(arcPosRow);

        const arcPersistSwitch = new Adw.SwitchRow({
            title: _('Persistent Mode'),
            subtitle: _('Keep the arc carousel shown whenever no window overlaps its area'),
        });
        settings.bind('arc-persistent-mode', arcPersistSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        arcGroup.add(arcPersistSwitch);

        this._addSpinRow(arcGroup, settings, 'arc-angle-step',
            _('Arc Angle Step'), _('Degrees between cards (8-30)'), 8, 30, 1);
        this._addSpinRow(arcGroup, settings, 'arc-card-scale',
            _('Arc Card Scale'), _('Card size percentage (50-150)'), 50, 150, 5);
        this._addSpinRow(arcGroup, settings, 'arc-scroll-speed',
            _('Arc Scroll Speed'), _('Momentum-scroll speed (1-20)'), 1, 20, 1);
        this._addSpinRow(arcGroup, settings, 'arc-hover-fan-delay',
            _('Hover Fan Delay'), _('Milliseconds to hover a group before it fans out (0 = never, fan only on click or scroll)'), 0, 3000, 50);

        const fanHoldSwitch = new Adw.SwitchRow({
            title: _('Hold Expanded Group'),
            subtitle: _('Keep a group expanded briefly after the pointer leaves it'),
        });
        settings.bind('arc-fan-hold', fanHoldSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        arcGroup.add(fanHoldSwitch);

        const fanHoldRow = this._addSpinRow(arcGroup, settings, 'arc-fan-hold-delay',
            _('Expanded Group Hold Delay'), _('Milliseconds to keep a group expanded after leaving (0 = instant)'), 0, 5000, 50);
        fanHoldSwitch.bind_property('active', fanHoldRow, 'sensitive', GObject.BindingFlags.SYNC_CREATE);

        const hideActiveSwitch = new Adw.SwitchRow({
            title: _('Hide Active Card'),
            subtitle: _('Hide the card or group that contains the focused window'),
        });
        settings.bind('arc-hide-active', hideActiveSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        arcGroup.add(hideActiveSwitch);

        const keepVisibleSwitch = new Adw.SwitchRow({
            title: _('Keep Windows Visible'),
            subtitle: _('Keep previous windows visible when a new window opens. When off, opening a window minimizes the others so only the newest shows.'),
        });
        settings.bind('arc-keep-visible', keepVisibleSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        arcGroup.add(keepVisibleSwitch);

        const showInOverviewSwitch = new Adw.SwitchRow({
            title: _('Show in Overview'),
            subtitle: _('Show the sidebar while the GNOME overview is active'),
        });
        settings.bind('arc-show-in-overview', showInOverviewSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        arcGroup.add(showInOverviewSwitch);

        const overviewMergeSwitch = new Adw.SwitchRow({
            title: _('Merge Apps Opened From Overview'),
            subtitle: _('Join a new app opened from the overview to the active card/group (if any)'),
        });
        settings.bind('arc-overview-merge', overviewMergeSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        arcGroup.add(overviewMergeSwitch);

        // Card scale/perspective are the Stack layout's own 3D card effect —
        // Arc has its own separate 'arc-card-scale' above and no perspective tilt.
        const cardGroup = new Adw.PreferencesGroup({ title: _('Cards'), description: _('Stack layout only') });
        lookPage.add(cardGroup);
        this._bindLayoutVisibility(cardGroup, settings, 'stack');

        this._addSpinRow(cardGroup, settings, 'card-base-scale',
            _('Card Base Scale'), _('Default card size percentage (40-100)'), 40, 100, 5);
        this._addSpinRow(cardGroup, settings, 'perspective-angle',
            _('Perspective Angle'), _('3D rotation in degrees (0 = flat)'), 0, 45, 1);

        const animGroup = new Adw.PreferencesGroup({ title: _('Animation') });
        lookPage.add(animGroup);

        // Slide duration is the Stack panel's own show/hide animation; Arc's
        // card motions use their own fixed durations. Hide Delay (below) is
        // shared — both layouts read auto-hide-delay.
        const animDurationRow = this._addSpinRow(animGroup, settings, 'animation-duration',
            _('Animation Duration'), _('Slide speed in milliseconds'), 0, 1000, 25);
        this._bindLayoutSensitivity(animDurationRow, settings, 'stack');
        this._addSpinRow(animGroup, settings, 'auto-hide-delay',
            _('Hide Delay'), _('Delay before hiding after mouse leaves (ms)'), 100, 5000, 100);

        // ── About & Logs Page ──
        const aboutPage = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'dialog-information-symbolic',
        });
        window.add(aboutPage);

        const infoGroup = new Adw.PreferencesGroup({ title: _('Stage Manager') });
        aboutPage.add(infoGroup);

        const versionRow = new Adw.ActionRow({
            title: _('Version'),
            subtitle: this.metadata['version-name'] || '1.4.0',
        });
        infoGroup.add(versionRow);

        const gnomeRow = new Adw.ActionRow({
            title: _('GNOME Shell'),
            subtitle: this._getGnomeVersion(),
        });
        infoGroup.add(gnomeRow);

        const sessionRow = new Adw.ActionRow({
            title: _('Session Type'),
            subtitle: GLib.getenv('XDG_SESSION_TYPE') || _('unknown'),
        });
        infoGroup.add(sessionRow);

        // Project links — the repo URL comes from metadata.json so it stays in
        // step with what EGO shows on the extension's page.
        const repoUrl = this.metadata.url || 'https://github.com/itsdigvijaysing/gnome-stage-manager';
        const linkGroup = new Adw.PreferencesGroup({
            title: _('Project'),
            description: _('Source code, issue tracker and releases on GitHub'),
        });
        aboutPage.add(linkGroup);

        linkGroup.add(this._addLinkRow(_('Repository'),
            _('Browse the source, licence and changelog'), repoUrl, _('Open')));
        linkGroup.add(this._addLinkRow(_('Report an Issue'),
            _('Bug reports and feature requests'), `${repoUrl}/issues`, _('Open')));

        // Logs section
        const logGroup = new Adw.PreferencesGroup({
            title: _('Extension Logs'),
            description: _('Recent errors from this extension (for bug reports)'),
        });
        aboutPage.add(logGroup);

        const showLogsRow = new Adw.ActionRow({
            title: _('Show Logs'),
            subtitle: _('The journal is read only when you ask for it'),
        });
        const showLogsBtn = new Gtk.Button({
            label: _('Show'),
            valign: Gtk.Align.CENTER,
        });
        showLogsRow.add_suffix(showLogsBtn);
        logGroup.add(showLogsRow);

        const logView = new Gtk.TextView({
            editable: false,
            monospace: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            vexpand: true,
        });
        logView.set_size_request(-1, 200);

        const scrollWin = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            min_content_height: 200,
        });
        scrollWin.set_child(logView);

        const logRow = new Adw.PreferencesRow();
        logRow.set_child(scrollWin);
        logGroup.add(logRow);

        // Not loaded on open — spawning `journalctl` unprompted is an EGO reviewer objection.
        logView.get_buffer().set_text(
            _('Press Refresh to load recent log messages.'), -1);

        // Refresh button
        const refreshRow = new Adw.ActionRow({ title: _('Refresh Logs') });
        const refreshBtn = new Gtk.Button({
            label: _('Refresh'),
            valign: Gtk.Align.CENTER,
        });
        refreshBtn.connect('clicked', () => this._loadLogs(logView));
        refreshRow.add_suffix(refreshBtn);
        logGroup.add(refreshRow);

        // Copy button
        const copyRow = new Adw.ActionRow({ title: _('Copy Logs') });
        const copyBtn = new Gtk.Button({
            label: _('Copy to Clipboard'),
            valign: Gtk.Align.CENTER,
        });
        copyBtn.connect('clicked', () => {
            const buf = logView.get_buffer();
            const [start, end] = [buf.get_start_iter(), buf.get_end_iter()];
            const text = buf.get_text(start, end, false);
            const clipboard = logView.get_clipboard();
            if (clipboard)
                clipboard.set(text);
        });
        copyRow.add_suffix(copyBtn);
        logGroup.add(copyRow);

        // Hidden until asked for; the first reveal is also what triggers the
        // journal read, so opening preferences never spawns a subprocess.
        [logRow, refreshRow, copyRow].forEach(r => { r.visible = false; });
        showLogsBtn.connect('clicked', () => {
            const showing = !logRow.visible;
            [logRow, refreshRow, copyRow].forEach(r => { r.visible = showing; });
            showLogsBtn.label = showing ? _('Hide') : _('Show');
            if (showing) this._loadLogs(logView);
        });

        // Reset — destructive, so it sits last and asks first.
        const resetGroup = new Adw.PreferencesGroup({
            title: _('Reset'),
            description: _('Return every Stage Manager preference to its default'),
        });
        aboutPage.add(resetGroup);

        const resetRow = new Adw.ActionRow({
            title: _('Reset All Settings'),
            subtitle: _('Layout, sidebar, cards, shortcuts and merged groups'),
        });
        const resetBtn = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetBtn.connect('clicked', () => this._confirmReset(window, settings));
        resetRow.add_suffix(resetBtn);
        resetGroup.add(resetRow);
    }

    /** An ActionRow whose suffix button opens `uri` in the default browser. */
    _addLinkRow(title, subtitle, uri, label) {
        const row = new Adw.ActionRow({ title, subtitle });
        const button = new Gtk.LinkButton({
            label,
            uri,
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(button);
        return row;
    }

    /** Ask before wiping settings — a reset is not undoable. */
    _confirmReset(window, settings) {
        const dialog = new Adw.AlertDialog({
            heading: _('Reset All Settings?'),
            body: _('Every preference returns to its default, including merged groups and keyboard shortcuts. This cannot be undone.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('reset', _('Reset'));
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response === 'reset') {
                for (const key of settings.settings_schema.list_keys())
                    settings.reset(key);
            }
        });
        dialog.present(window);
    }

    /** Grey out `widget` (a group or row) while sidebar-layout isn't `wantedLayout`. */
    _bindLayoutSensitivity(widget, settings, wantedLayout) {
        const update = () => {
            widget.sensitive = settings.get_string('sidebar-layout') === wantedLayout;
        };
        update();
        const id = settings.connect('changed::sidebar-layout', update);
        widget.connect('destroy', () => settings.disconnect(id));
    }

    /** For groups that belong entirely to one layout: hide rather than grey out,
     *  so the page only ever shows the settings that actually apply. Mixed
     *  groups keep _bindLayoutSensitivity so their inert rows stay discoverable. */
    _bindLayoutVisibility(widget, settings, wantedLayout) {
        const update = () => {
            widget.visible = settings.get_string('sidebar-layout') === wantedLayout;
        };
        update();
        const id = settings.connect('changed::sidebar-layout', update);
        widget.connect('destroy', () => settings.disconnect(id));
    }

    _addSpinRow(group, settings, key, title, subtitle, min, max, step) {
        const row = new Adw.ActionRow({ title, subtitle });
        const adj = new Gtk.Adjustment({
            lower: min, upper: max,
            step_increment: step, page_increment: step * 5,
        });
        const spin = new Gtk.SpinButton({ adjustment: adj, valign: Gtk.Align.CENTER });
        settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(spin);
        group.add(row);
        return row;
    }

    _addShortcutRow(group, settings, key, title, subtitle) {
        const row = new Adw.ActionRow({ title, subtitle });

        const label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        const refreshLabel = () => {
            const accels = settings.get_strv(key);
            label.set_accelerator(accels.length > 0 ? accels[0] : '');
        };
        refreshLabel();
        const settingsId = settings.connect(`changed::${key}`, refreshLabel);
        row.connect('destroy', () => settings.disconnect(settingsId));

        const setBtn = new Gtk.Button({
            label: _('Set'),
            valign: Gtk.Align.CENTER,
        });
        setBtn.connect('clicked', () => this._captureShortcut(setBtn.get_root(), settings, key));

        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Clear shortcut'),
        });
        clearBtn.connect('clicked', () => settings.set_strv(key, []));

        row.add_suffix(label);
        row.add_suffix(setBtn);
        row.add_suffix(clearBtn);
        group.add(row);
    }

    _captureShortcut(parent, settings, key) {
        // Adw.MessageDialog is deprecated in favor of Adw.AlertDialog (1.6+) — prefer it when available.
        const useAlert = typeof Adw.AlertDialog === 'function';
        const dialog = useAlert
            ? new Adw.AlertDialog({
                heading: _('Press shortcut'),
                body: _('Press the key combination you want to use, or Escape to cancel.'),
            })
            : new Adw.MessageDialog({
                transient_for: parent,
                modal: true,
                heading: _('Press shortcut'),
                body: _('Press the key combination you want to use, or Escape to cancel.'),
            });
        dialog.add_response('cancel', _('Cancel'));

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, _kc, state) => {
            // Ignore modifier-only presses.
            if (this._isModifierKey(keyval)) return Gdk.EVENT_PROPAGATE;

            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && mask === 0) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            const accel = Gtk.accelerator_name(keyval, mask);
            if (accel && accel.length > 0) {
                settings.set_strv(key, [accel]);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        if (useAlert) dialog.present(parent);
        else dialog.present();
    }

    _isModifierKey(keyval) {
        return keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R ||
               keyval === Gdk.KEY_Shift_L   || keyval === Gdk.KEY_Shift_R   ||
               keyval === Gdk.KEY_Alt_L     || keyval === Gdk.KEY_Alt_R     ||
               keyval === Gdk.KEY_Super_L   || keyval === Gdk.KEY_Super_R   ||
               keyval === Gdk.KEY_Meta_L    || keyval === Gdk.KEY_Meta_R    ||
               keyval === Gdk.KEY_Hyper_L   || keyval === Gdk.KEY_Hyper_R;
    }

    _getGnomeVersion() {
        return Config.PACKAGE_VERSION || _('unknown');
    }

    /** Read this extension's recent log lines out of the journal (Refresh button
     *  only) — no GIO API for the journal, so an async read-only subprocess is unavoidable. */
    _loadLogs(textView) {
        const buf = textView.get_buffer();
        let proc;
        try {
            // Matches both '[stage-manager] …' lines and the shell's own UUID-quoted errors.
            proc = Gio.Subprocess.new(
                ['journalctl', '--user', '-b', '--no-pager', '-n', '50',
                 '-g', 'stage.?manager'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (_e) {
            buf.set_text(`${_('Could not load logs. Run manually:')}\njournalctl --user -b -g stage-manager`, -1);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            let text = '';
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                text = (stdout || '').trim();
            } catch (_e) { /* leave text empty */ }
            buf.set_text(text || _('No recent logs found.'), -1);
        });
    }
}
