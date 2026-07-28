/**
 * On-screen indicator for virtual workspace switches.
 *
 * GNOME shows a small pill with one dot per workspace whenever you switch, and
 * that feedback is precisely what virtual workspaces lack. The panel indicator
 * lives on the primary monitor, so switching a *secondary* monitor means the
 * confirmation appears on a different screen than the one that just changed —
 * you look away from the thing you were looking at.
 *
 * The shell's own popup cannot be reused. WorkspaceSwitcherPopup branches on
 * the very setting this extension requires:
 *
 *     if (Meta.prefs_get_workspaces_only_on_primary())
 *         constraint = new Layout.MonitorConstraint({primary: true});
 *
 * so with the setting on it builds exactly one popup, pinned to the primary
 * monitor — it will never appear where we need it. Its dot count also comes
 * straight from `global.workspace_manager.n_workspaces`, which has nothing to
 * do with our virtual count.
 *
 * What *is* reused is the appearance: `workspace-switcher` and
 * `ws-switcher-indicator` are style classes the shell theme already defines
 * (pill background, dot sizing, `:active` for the current one, the 4em lift off
 * the bottom edge). Borrowing them keeps this identical to the native OSD
 * without shipping a copy of its CSS, and it degrades well — a theme that drops
 * them renders an unstyled popup instead of throwing, which would not be true
 * of reaching into the shell's private actor fields.
 *
 * One popup per monitor, kept alive and reused rather than destroyed on
 * timeout the way the shell does. The shell can afford to destroy because
 * windowManager recreates on demand; here, keeping them removes the only real
 * hazard — a fade-out completing into a destroy while a second switch is
 * already reusing the actor.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ANIMATION_TIME } from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import { monitorIndexOf } from './monitorState.js';

/** How long the pill stays up. The shell keeps its copy private, so: duplicated. */
const DISPLAY_TIMEOUT = 600;

const MonitorPopup = GObject.registerClass(
class IslandsMonitorPopup extends Clutter.Actor {
    _init(monitorIndex) {
        super._init({
            offscreen_redirect: Clutter.OffscreenRedirect.ALWAYS,
            // Explicit BinLayout rather than the default fixed layout: the pill
            // is placed by the child's alignment, and that only means something
            // in a layout manager that honours it.
            layout_manager: new Clutter.BinLayout(),
            opacity: 0,
            visible: false,
        });

        // Sizes and positions this actor over exactly one monitor. Not reactive
        // (Clutter's default), so covering the screen swallows no input.
        this.add_constraint(new Layout.MonitorConstraint({ index: monitorIndex }));

        this._list = new St.BoxLayout({
            style_class: 'workspace-switcher',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this.add_child(this._list);

        this._timeoutId = 0;
        this.connect('destroy', () => this._onDestroy());
    }

    /**
     * @param {number} activeIndex zero-based active virtual workspace
     * @param {number} count       virtual workspaces on this monitor
     */
    display(activeIndex, count) {
        this._rebuild(activeIndex, count);
        this._restartTimeout();

        // Fully visible already means a second switch landed inside the display
        // window: swap the dots and leave it alone. Replaying the fade on every
        // switch makes fast rotation strobe.
        const duration = this.opacity === 255 ? 0 : ANIMATION_TIME;

        this.show();
        this.ease({
            opacity: 255,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _rebuild(activeIndex, count) {
        this._list.destroy_all_children();

        for (let i = 0; i < count; i++) {
            const dot = new St.Bin({ style_class: 'ws-switcher-indicator' });

            if (i === activeIndex)
                dot.add_style_pseudo_class('active');

            this._list.add_child(dot);
        }
    }

    _restartTimeout() {
        if (this._timeoutId)
            GLib.Source.remove(this._timeoutId);

        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, DISPLAY_TIMEOUT, () => {
                this._timeoutId = 0;
                this._fadeOut();
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(
            this._timeoutId, '[workspace-islands] switcher popup');
    }

    /**
     * Hide, don't destroy. A later display() eases opacity again, which
     * replaces this transition — so onComplete never runs and no stray hide
     * lands on a popup that is being shown again.
     */
    _fadeOut() {
        this.ease({
            opacity: 0,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.hide(),
        });
    }

    _onDestroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }
});

export class SwitcherPopup {
    constructor(settings) {
        this._settings = settings;
        this._popups = new Map();

        // A MonitorConstraint holds a monitor *index*, and indices are
        // reshuffled on hotplug — a popup that outlived a layout change would
        // be pinned to the wrong screen. Cheaper to drop them than to retarget.
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._destroyPopups());
    }

    /** @param {import('./monitorState.js').MonitorState} state the monitor that just switched */
    show(state) {
        if (!this._settings?.get_boolean('switcher-popup'))
            return;

        // The overview already shows workspaces; a pill floating over it is
        // noise. The shell skips its own popup for the same reason.
        if (Main.overview.visible)
            return;

        const monitorIndex = monitorIndexOf(state.connector);
        if (monitorIndex < 0)
            return;

        let popup = this._popups.get(state.connector);
        if (!popup) {
            popup = new MonitorPopup(monitorIndex);
            Main.uiGroup.add_child(popup);
            this._popups.set(state.connector, popup);
        }

        popup.display(state.activeIndex, state.size);
    }

    destroy() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this._destroyPopups();
        this._settings = null;
    }

    _destroyPopups() {
        for (const popup of this._popups.values())
            popup.destroy();

        this._popups.clear();
    }
}
