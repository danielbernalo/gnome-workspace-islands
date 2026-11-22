// Reimplemented: the shell's WorkspaceSwitcherPopup is pinned to the primary monitor.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ANIMATION_TIME } from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import { monitorIndexOf } from './monitorState.js';

// The shell keeps its display timeout private, so it is duplicated here.
const DISPLAY_TIMEOUT = 600;

const MonitorPopup = GObject.registerClass(
class IslandsMonitorPopup extends Clutter.Actor {
    _init(monitorIndex) {
        super._init({
            offscreen_redirect: Clutter.OffscreenRedirect.ALWAYS,
            layout_manager: new Clutter.BinLayout(),
            opacity: 0,
            visible: false,
        });

        // Not reactive, so covering the whole monitor swallows no input.
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

    display(activeIndex, count) {
        this._rebuild(activeIndex, count);
        this._restartTimeout();

        // Already fully visible means a repeat switch: skip the fade, or fast rotation strobes.
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

    // Hide, don't destroy: a later display() replaces this ease, so this hide never runs then.
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

        // Monitor indices reshuffle on hotplug, so popups pinned by index are dropped instead.
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._destroyPopups());
    }

    show(state) {
        if (!this._settings?.get_boolean('switcher-popup'))
            return;

        if (Main.overview.visible)
            return;

        // The lock shield is chrome but add_child() appends, so this would cover the lock screen.
        if (Main.sessionMode.isLocked)
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
