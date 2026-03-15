/**
 * Stage Manager - Preferences UI
 *
 * Settings panel for the Stage Manager extension.
 * Uses Adw (libadwaita) widgets for GNOME 45+ preferences.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


export default class StageManagerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // --- General Page ---
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        // Maximize to Workspace group
        const maxGroup = new Adw.PreferencesGroup({
            title: 'Maximize to Workspace',
            description: 'Automatically move maximized windows to their own workspace',
        });
        generalPage.add(maxGroup);

        const maxSwitch = new Adw.SwitchRow({
            title: 'Enable Maximize to Workspace',
            subtitle: 'Maximized windows get their own workspace',
        });
        settings.bind('enable-maximize-to-workspace', maxSwitch, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        maxGroup.add(maxSwitch);

        // Stage Sidebar group
        const sidebarGroup = new Adw.PreferencesGroup({
            title: 'Stage Manager Sidebar',
            description: 'Sidebar showing inactive window thumbnails',
        });
        generalPage.add(sidebarGroup);

        const sidebarSwitch = new Adw.SwitchRow({
            title: 'Enable Stage Sidebar',
            subtitle: 'Show inactive windows in a left-side panel',
        });
        settings.bind('enable-stage-sidebar', sidebarSwitch, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        sidebarGroup.add(sidebarSwitch);

        const autoHideSwitch = new Adw.SwitchRow({
            title: 'Auto-hide Sidebar',
            subtitle: 'Hide sidebar when not hovering',
        });
        settings.bind('sidebar-auto-hide', autoHideSwitch, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        sidebarGroup.add(autoHideSwitch);

        const showIconsSwitch = new Adw.SwitchRow({
            title: 'Show Application Icons',
            subtitle: 'Display app icons below thumbnails',
        });
        settings.bind('show-app-icons', showIconsSwitch, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        sidebarGroup.add(showIconsSwitch);

        // --- Appearance Page ---
        const appearancePage = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(appearancePage);

        const sizeGroup = new Adw.PreferencesGroup({
            title: 'Dimensions',
        });
        appearancePage.add(sizeGroup);

        // Sidebar width
        const widthRow = new Adw.ActionRow({
            title: 'Sidebar Width',
            subtitle: 'Width of the sidebar in pixels',
        });
        const widthAdj = new Gtk.Adjustment({
            lower: 120,
            upper: 400,
            step_increment: 10,
            page_increment: 50,
        });
        const widthSpin = new Gtk.SpinButton({
            adjustment: widthAdj,
            valign: Gtk.Align.CENTER,
        });
        settings.bind('sidebar-width', widthSpin, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        widthRow.add_suffix(widthSpin);
        sizeGroup.add(widthRow);

        // Edge trigger width
        const edgeRow = new Adw.ActionRow({
            title: 'Edge Trigger Width',
            subtitle: 'Width of the hot zone at screen edge (pixels)',
        });
        const edgeAdj = new Gtk.Adjustment({
            lower: 1,
            upper: 20,
            step_increment: 1,
            page_increment: 5,
        });
        const edgeSpin = new Gtk.SpinButton({
            adjustment: edgeAdj,
            valign: Gtk.Align.CENTER,
        });
        settings.bind('edge-trigger-width', edgeSpin, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        edgeRow.add_suffix(edgeSpin);
        sizeGroup.add(edgeRow);

        // Animation group
        const animGroup = new Adw.PreferencesGroup({
            title: 'Animation',
        });
        appearancePage.add(animGroup);

        // Animation duration
        const animRow = new Adw.ActionRow({
            title: 'Animation Duration',
            subtitle: 'Slide animation speed (milliseconds)',
        });
        const animAdj = new Gtk.Adjustment({
            lower: 0,
            upper: 1000,
            step_increment: 25,
            page_increment: 100,
        });
        const animSpin = new Gtk.SpinButton({
            adjustment: animAdj,
            valign: Gtk.Align.CENTER,
        });
        settings.bind('animation-duration', animSpin, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        animRow.add_suffix(animSpin);
        animGroup.add(animRow);

        // Auto-hide delay
        const delayRow = new Adw.ActionRow({
            title: 'Auto-hide Delay',
            subtitle: 'Delay before hiding sidebar (milliseconds)',
        });
        const delayAdj = new Gtk.Adjustment({
            lower: 100,
            upper: 5000,
            step_increment: 100,
            page_increment: 500,
        });
        const delaySpin = new Gtk.SpinButton({
            adjustment: delayAdj,
            valign: Gtk.Align.CENTER,
        });
        settings.bind('auto-hide-delay', delaySpin, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        delayRow.add_suffix(delaySpin);
        animGroup.add(delayRow);
    }
}
