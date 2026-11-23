// Wheel clicks skip the SwipeTracker and hit handleWorkspaceScroll, a live lookup we can override.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WindowManager } from 'resource:///org/gnome/shell/ui/windowManager.js';

// Matches the shell's throttle; both paths share the same WindowManager._canScroll flag.
const SCROLL_TIMEOUT_MS = 150;

let injector = null;

let throttleId = 0;

export function patch({ getState, onScroll, log }) {
    const proto = WindowManager?.prototype;

    if (!proto || typeof proto.handleWorkspaceScroll !== 'function') {
        console.warn('workspace-islands: WindowManager.handleWorkspaceScroll not ' +
            'found — Super + wheel will not switch workspaces on secondary monitors');
        return;
    }

    injector = new InjectionManager();

    injector.overrideMethod(proto, 'handleWorkspaceScroll',
        originalMethod => function (event) {
            const state = getState();
            if (!state)
                return originalMethod.call(this, event);

            if (!this._canScroll)
                return Clutter.EVENT_PROPAGATE;

            const delta = scrollDelta(event);
            if (delta === 0)
                return Clutter.EVENT_PROPAGATE;

            // Clamped like the primary monitor's wheel, unlike the wrapping keyboard shortcuts.
            const to = Math.min(Math.max(state.activeIndex + delta, 0), state.size - 1);

            if (to !== state.activeIndex) {
                log(`wheel on ${state.connector}: ` +
                    `${state.activeIndex + 1} -> ${to + 1}`);
                onScroll(state, to, delta > 0);
            }

            // Stop even at the range ends, or the event would fall through to the primary.
            this._canScroll = false;
            throttle(this);

            return Clutter.EVENT_STOP;
        });
}

export function unpatch() {
    injector?.clear();
    injector = null;

    releaseScroll();
}

function throttle(windowManager) {
    // Not releaseScroll(): resetting Main.wm._canScroll here would undo the hold just set.
    dropThrottle();

    throttleId = GLib.timeout_add_once(
        GLib.PRIORITY_DEFAULT, SCROLL_TIMEOUT_MS, () => {
            throttleId = 0;
            windowManager._canScroll = true;
        });
}

function dropThrottle() {
    if (throttleId) {
        GLib.Source.remove(throttleId);
        throttleId = 0;
    }
}

function releaseScroll() {
    dropThrottle();

    // Unconditional, so unloading mid-hold cannot leave the shell's own wheel jammed.
    if (Main.wm)
        Main.wm._canScroll = true;
}

// Smooth events map to 0 on purpose: a swipe tracker already drives them.
export function scrollDelta(event) {
    switch (event.get_scroll_direction()) {
    case Clutter.ScrollDirection.UP:
    case Clutter.ScrollDirection.LEFT:
        return -1;
    case Clutter.ScrollDirection.DOWN:
    case Clutter.ScrollDirection.RIGHT:
        return 1;
    default:
        return 0;
    }
}
