/**
 * Preferences window.
 *
 * Runs in its own process with GTK4/Adwaita — no Clutter, Meta, St or Shell
 * here. The only thing shared with the extension is the settings schema.
 *
 * The Diagnostics group is not decoration. This extension depends on a mutter
 * setting that other software flips (PaperWM forces it off), and when it is
 * off nothing works and the reason is invisible. Surfacing it with a one-click
 * fix turns the worst failure mode into a non-event.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MUTTER_SCHEMA = 'org.gnome.mutter';
const ONLY_ON_PRIMARY = 'workspaces-only-on-primary';

const SHORTCUTS = [
    ['switch-prev', 'Previous virtual workspace'],
    ['switch-next', 'Next virtual workspace'],
    ['switch-to-1', 'Switch to workspace 1'],
    ['switch-to-2', 'Switch to workspace 2'],
    ['switch-to-3', 'Switch to workspace 3'],
    ['switch-to-4', 'Switch to workspace 4'],
    ['switch-to-5', 'Switch to workspace 5'],
    ['switch-to-6', 'Switch to workspace 6'],
    ['switch-to-7', 'Switch to workspace 7'],
    ['switch-to-8', 'Switch to workspace 8'],
    ['move-window-to-prev', 'Move window to previous workspace'],
    ['move-window-to-next', 'Move window to next workspace'],
];

export default class WorkspaceIslandsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._generalPage(settings));
        window.add(this._shortcutsPage(settings, window));
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Virtual workspaces'),
            description: _('Applies to every monitor other than the primary ' +
                'one. The primary monitor keeps using GNOME’s own workspaces.'),
        });

        const count = new Adw.SpinRow({
            title: _('Workspaces per monitor'),
            adjustment: new Gtk.Adjustment({
                lower: 2,
                upper: 8,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        settings.bind('virtual-workspaces', count, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(count);

        page.add(group);
        page.add(this._feelGroup(settings));
        page.add(this._diagnosticsGroup());

        const debugGroup = new Adw.PreferencesGroup({ title: _('Troubleshooting') });
        const debug = new Adw.SwitchRow({
            title: _('Debug logging'),
            subtitle: _('Log workspace switches to the journal'),
        });
        settings.bind('debug-logging', debug, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        debugGroup.add(debug);
        page.add(debugGroup);

        return page;
    }

    /**
     * The three things that decide whether this feels like GNOME.
     *
     * All default on. They are switches rather than assumptions because each
     * one buys its polish with something real — the slide clones windows while
     * it runs, and the gesture claims three-finger swipes on secondary
     * monitors.
     */
    _feelGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Switching'),
            description: _('Matches how GNOME switches its own workspaces.'),
        });

        const rows = [
            ['touchpad-gesture', _('Touchpad gesture'),
                _('Three-finger swipe over a secondary monitor. GNOME’s own ' +
                'gesture ignores those, so nothing is taken from the primary.')],
            ['switch-animation', _('Slide animation'),
                _('Slide between workspaces instead of showing the minimize ' +
                'animation. Clones the windows involved while it runs.')],
            ['switcher-popup', _('On-screen indicator'),
                _('The workspace dots GNOME shows on a switch, on the monitor ' +
                'that changed.')],
        ];

        for (const [key, title, subtitle] of rows) {
            const row = new Adw.SwitchRow({ title, subtitle });
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }

        return group;
    }

    /**
     * Live view of the one setting the whole design rests on.
     *
     * Windows on secondary monitors are only sticky while this is true. With
     * it off, virtual workspaces leak into each other and nothing explains
     * why — so it is shown, watched, and fixable from here.
     */
    _diagnosticsGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Diagnostics'),
            description: _('Windows on secondary monitors must be sticky for ' +
                'virtual workspaces to work.'),
        });

        let mutter;
        try {
            mutter = new Gio.Settings({ schema_id: MUTTER_SCHEMA });
        } catch {
            const row = new Adw.ActionRow({
                title: _('Could not read mutter settings'),
                subtitle: _('Schema %s is unavailable').format(MUTTER_SCHEMA),
            });
            group.add(row);
            return group;
        }

        const row = new Adw.ActionRow({ title: `${MUTTER_SCHEMA}.${ONLY_ON_PRIMARY}` });

        const fix = new Gtk.Button({
            label: _('Turn on'),
            valign: Gtk.Align.CENTER,
        });
        fix.add_css_class('suggested-action');
        fix.connect('clicked', () => mutter.set_boolean(ONLY_ON_PRIMARY, true));

        row.add_suffix(fix);
        group.add(row);

        const refresh = () => {
            const ok = mutter.get_boolean(ONLY_ON_PRIMARY);
            row.subtitle = ok
                ? _('Enabled — virtual workspaces can work')
                : _('Disabled — virtual workspaces will not work');
            fix.visible = !ok;
        };

        mutter.connect(`changed::${ONLY_ON_PRIMARY}`, refresh);
        refresh();

        return group;
    }

    _shortcutsPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: _('Shortcuts'),
            icon_name: 'preferences-desktop-keyboard-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Keyboard shortcuts'),
            description: _('Shortcuts act on the monitor holding the focused ' +
                'window. On the primary monitor they do nothing, since GNOME’s ' +
                'own workspace shortcuts already cover it.'),
        });

        for (const [key, title] of SHORTCUTS)
            group.add(new ShortcutRow(settings, key, title, window));

        page.add(group);
        return page;
    }
}

/**
 * A row that captures a key combination.
 *
 * Clicking opens a modal that grabs the next chord. Escape cancels, Backspace
 * clears — the conventions GNOME's own keyboard settings use, so the behaviour
 * needs no explaining.
 */
const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(settings, key, title, window) {
        super._init({ title, activatable: true });

        this._settings = settings;
        this._key = key;
        this._window = window;

        this._label = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: _('Disabled'),
        });
        this.add_suffix(this._label);

        // Settings outlive this row, so the handler has to come back off.
        this._changedId = this._settings.connect(
            `changed::${key}`, () => this._sync());
        this.connect('destroy', () => {
            if (this._changedId) {
                this._settings.disconnect(this._changedId);
                this._changedId = 0;
            }
        });

        this.connect('activated', () => this._capture());
        this._sync();
    }

    _sync() {
        const [accel] = this._settings.get_strv(this._key);
        this._label.accelerator = accel ?? '';
    }

    _capture() {
        const dialog = new Adw.Window({
            modal: true,
            transient_for: this._window,
            default_width: 400,
            default_height: 200,
            title: this.title,
        });

        const status = new Adw.StatusPage({
            title: _('Press a shortcut'),
            description: _('Esc to cancel, Backspace to clear'),
            icon_name: 'preferences-desktop-keyboard-symbolic',
        });
        dialog.set_content(status);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();

            if (keyval === Gdk.KEY_Escape && !mask) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            if (keyval === Gdk.KEY_BackSpace && !mask) {
                this._settings.set_strv(this._key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            // A bare modifier is the user mid-chord, not the chord itself.
            if (!isBindable(keyval, mask))
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name_with_keycode(
                null, keyval, keycode, mask);

            this._settings.set_strv(this._key, [accel]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });

        dialog.add_controller(controller);
        dialog.present();
    }
});

function isBindable(keyval, mask) {
    if (!Gtk.accelerator_valid(keyval, mask))
        return false;

    // Require a modifier: a plain letter would swallow that key system-wide.
    return mask !== 0;
}
