/**
 * Stage Manager - Preferences UI
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


export default class StageManagerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // ── Behavior Page ──
        const behaviorPage = new Adw.PreferencesPage({
            title: 'Behavior',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(behaviorPage);

        // Maximize to Workspace
        const maxGroup = new Adw.PreferencesGroup({
            title: 'Maximize to Workspace',
            description: 'Move maximized windows to their own workspace',
        });
        behaviorPage.add(maxGroup);

        const maxSwitch = new Adw.SwitchRow({
            title: 'Enable Maximize to Workspace',
            subtitle: 'When maximized, window moves to a new empty workspace',
        });
        settings.bind('enable-maximize-to-workspace', maxSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        maxGroup.add(maxSwitch);

        // Stage Sidebar
        const sideGroup = new Adw.PreferencesGroup({
            title: 'Stage Manager Sidebar',
            description: 'Left sidebar showing inactive app thumbnails',
        });
        behaviorPage.add(sideGroup);

        const sideSwitch = new Adw.SwitchRow({
            title: 'Enable Stage Sidebar',
            subtitle: 'Show inactive apps as thumbnail cards on the left',
        });
        settings.bind('enable-stage-sidebar', sideSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        sideGroup.add(sideSwitch);

        // Sidebar mode
        const modeRow = new Adw.ActionRow({
            title: 'Sidebar Content',
            subtitle: 'What to show in the sidebar cards',
        });
        const modeDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(['Apps (current workspace)', 'Workspaces']),
            valign: Gtk.Align.CENTER,
        });
        // Sync setting → dropdown
        const modeVal = settings.get_string('sidebar-mode');
        modeDropdown.set_selected(modeVal === 'workspaces' ? 1 : 0);
        // Sync dropdown → setting
        modeDropdown.connect('notify::selected', () => {
            const sel = modeDropdown.get_selected();
            settings.set_string('sidebar-mode', sel === 1 ? 'workspaces' : 'apps');
        });
        modeRow.add_suffix(modeDropdown);
        sideGroup.add(modeRow);

        const autoHideSwitch = new Adw.SwitchRow({
            title: 'Auto-hide Sidebar',
            subtitle: 'Off = always visible (macOS default). On = hover to reveal.',
        });
        settings.bind('sidebar-auto-hide', autoHideSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        sideGroup.add(autoHideSwitch);

        const iconSwitch = new Adw.SwitchRow({
            title: 'Show App Icons',
            subtitle: 'Display app icon below each thumbnail',
        });
        settings.bind('show-app-icons', iconSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        sideGroup.add(iconSwitch);

        const showCurrentWsSwitch = new Adw.SwitchRow({
            title: 'Show Current Workspace',
            subtitle: 'In workspace mode, also show the current workspace card',
        });
        settings.bind('show-workspace-current', showCurrentWsSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        sideGroup.add(showCurrentWsSwitch);

        // ── Appearance Page ──
        const lookPage = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(lookPage);

        const sizeGroup = new Adw.PreferencesGroup({ title: 'Dimensions' });
        lookPage.add(sizeGroup);

        this._addSpinRow(sizeGroup, settings, 'sidebar-width',
            'Sidebar Width', 'Width in pixels', 120, 400, 10);
        this._addSpinRow(sizeGroup, settings, 'edge-trigger-width',
            'Edge Trigger Width', 'Hot zone at screen edge (pixels)', 1, 20, 1);

        const cardGroup = new Adw.PreferencesGroup({ title: 'Cards' });
        lookPage.add(cardGroup);

        this._addSpinRow(cardGroup, settings, 'card-base-scale',
            'Card Base Scale', 'Default card size percentage (40-100)', 40, 100, 5);
        this._addSpinRow(cardGroup, settings, 'perspective-angle',
            'Perspective Angle', '3D rotation in degrees (0 = flat)', 0, 45, 1);

        const animGroup = new Adw.PreferencesGroup({ title: 'Animation' });
        lookPage.add(animGroup);

        this._addSpinRow(animGroup, settings, 'animation-duration',
            'Animation Duration', 'Slide speed in milliseconds', 0, 1000, 25);
        this._addSpinRow(animGroup, settings, 'auto-hide-delay',
            'Hide Delay', 'Delay before hiding after mouse leaves (ms)', 100, 5000, 100);

        // ── About & Logs Page ──
        const aboutPage = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'dialog-information-symbolic',
        });
        window.add(aboutPage);

        const infoGroup = new Adw.PreferencesGroup({ title: 'Stage Manager' });
        aboutPage.add(infoGroup);

        const versionRow = new Adw.ActionRow({
            title: 'Version',
            subtitle: '1.0.0',
        });
        infoGroup.add(versionRow);

        const gnomeRow = new Adw.ActionRow({
            title: 'GNOME Shell',
            subtitle: this._getGnomeVersion(),
        });
        infoGroup.add(gnomeRow);

        const sessionRow = new Adw.ActionRow({
            title: 'Session Type',
            subtitle: GLib.getenv('XDG_SESSION_TYPE') || 'unknown',
        });
        infoGroup.add(sessionRow);

        // Logs section
        const logGroup = new Adw.PreferencesGroup({
            title: 'Extension Logs',
            description: 'Recent errors from this extension (for bug reports)',
        });
        aboutPage.add(logGroup);

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

        // Load logs
        this._loadLogs(logView);

        // Refresh button
        const refreshRow = new Adw.ActionRow({ title: 'Refresh Logs' });
        const refreshBtn = new Gtk.Button({
            label: 'Refresh',
            valign: Gtk.Align.CENTER,
        });
        refreshBtn.connect('clicked', () => this._loadLogs(logView));
        refreshRow.add_suffix(refreshBtn);
        logGroup.add(refreshRow);

        // Copy button
        const copyRow = new Adw.ActionRow({ title: 'Copy Logs' });
        const copyBtn = new Gtk.Button({
            label: 'Copy to Clipboard',
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
    }

    _getGnomeVersion() {
        try {
            const [ok, out] = GLib.spawn_command_line_sync('gnome-shell --version');
            if (ok) return new TextDecoder().decode(out).trim().replace('GNOME Shell ', '');
        } catch (_) { /* */ }
        return 'unknown';
    }

    _loadLogs(textView) {
        try {
            const [ok, out] = GLib.spawn_command_line_sync(
                'bash -c "journalctl --user -b --no-pager -n 50 -g stage-manager 2>/dev/null"'
            );
            const text = ok ? new TextDecoder().decode(out).trim() : '';
            const buf = textView.get_buffer();
            buf.set_text(text || 'No recent logs found.', -1);
        } catch (_e) {
            const buf = textView.get_buffer();
            buf.set_text('Could not load logs. Run manually:\njournalctl --user -b -g stage-manager', -1);
        }
    }
}
