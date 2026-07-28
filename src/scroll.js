/**
 * Super + mouse wheel, outside the overview.
 *
 * On the primary monitor this is one of GNOME's oldest habits: hold Super,
 * spin the wheel, walk through the workspaces. On a secondary monitor it did
 * nothing visible, and the reason is worth writing down because it is not the
 * one you would guess from the touchpad working fine.
 *
 * The two inputs part company early. `WindowManager` connects a single
 * `scroll-event` handler on the stage and asks the workspace animation first
 * whether it wants the event:
 *
 *     if (this._workspaceAnimation.canHandleScrollEvent(event))
 *         return Clutter.EVENT_PROPAGATE;
 *     ...
 *     return this.handleWorkspaceScroll(event);
 *
 * `canHandleScrollEvent` forwards to the SwipeTracker, which claims *smooth*
 * events — a touchpad. So two-finger and three-finger scrolling reach the
 * tracker, and slide.js already replaced that tracker with one that knows
 * about monitors. A discrete wheel click is not smooth, falls past that check,
 * and lands in `handleWorkspaceScroll`.
 *
 * And `handleWorkspaceScroll` has no notion of a monitor at all. It reads
 * `global.workspace_manager`, takes the active workspace's neighbour and
 * switches to it — wherever the pointer happens to be. With
 * `workspaces-only-on-primary = true` that moves the primary monitor and
 * leaves the secondary exactly as it was, which is precisely the report: the
 * gesture works, the wheel does not.
 *
 * So this is the sixth shell seam, and the easiest of them. The stage handler
 * calls `this.handleWorkspaceScroll(event)` as a live method lookup rather
 * than through a handler captured with `.bind()` at construction — the trap
 * slide.js and overview.js each document having fallen into. Overriding the
 * prototype is enough.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WindowManager } from 'resource:///org/gnome/shell/ui/windowManager.js';

/**
 * The shell's own rate limit, matched rather than reinvented.
 *
 * A wheel notch sends events far faster than a workspace can be switched, and
 * the shell throttles its own path to one switch per 150 ms. Both paths share
 * the `_canScroll` flag on the same WindowManager, so a wheel dragged across
 * the boundary between the two monitors keeps a single cadence instead of
 * accelerating as it crosses.
 */
const SCROLL_TIMEOUT_MS = 150;

let injector = null;

/** The pending throttle, so unpatch() can drop it. See {@link releaseScroll}. */
let throttleId = 0;

/**
 * @param {object} handlers
 * @param {() => object|null} handlers.getState state for the monitor under the
 *   pointer, or null when that is the primary
 * @param {(state: object, index: number, forward: boolean) => void}
 *   handlers.onScroll commit the switch
 * @param {(message: string) => void} handlers.log
 */
export function patch({ getState, onScroll, log }) {
    const proto = WindowManager?.prototype;

    // Never assume the seam is there. A shell that renames or drops this must
    // degrade to "the wheel only moves the primary monitor" — which is the
    // behaviour being fixed, not a broken extension.
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

            // Clamped, not wrapped — unlike the keyboard shortcuts, which do
            // wrap. This is deliberate and the asymmetry is the point: the
            // wheel is being asked to feel exactly like the wheel on the
            // primary monitor, and there it stops at the ends. A shortcut has
            // no such reference to live up to.
            const to = Math.min(Math.max(state.activeIndex + delta, 0), state.size - 1);

            if (to !== state.activeIndex) {
                log(`wheel on ${state.connector}: ` +
                    `${state.activeIndex + 1} -> ${to + 1}`);
                onScroll(state, to, delta > 0);
            }

            // Even when the switch was a no-op at the end of the range. The
            // event belonged to this monitor either way, and letting it fall
            // through would hand it to the primary — a wheel that does nothing
            // until you reach the last workspace and then starts moving the
            // *other* screen.
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

/**
 * Hold the wheel for one beat, and be able to let go early.
 *
 * The shell fires this and forgets it, which is its privilege — it is not
 * going anywhere. An extension that did the same would leave a source running
 * into a session where it no longer exists. Harmless in itself, since all the
 * callback does is restore a flag to the value the shell keeps it at anyway,
 * but "harmless leak" is not a category this is worth having.
 */
function throttle(windowManager) {
    releaseScroll();

    throttleId = GLib.timeout_add_once(
        GLib.PRIORITY_DEFAULT, SCROLL_TIMEOUT_MS, () => {
            throttleId = 0;
            windowManager._canScroll = true;
        });
}

/** Drop a pending throttle and hand the wheel straight back to the shell. */
function releaseScroll() {
    if (throttleId) {
        GLib.Source.remove(throttleId);
        throttleId = 0;
    }

    // Unconditionally, not only when a throttle was pending: unloading in the
    // middle of the hold would otherwise leave the shell's own wheel jammed
    // until something else happened to set it back.
    if (Main.wm)
        Main.wm._canScroll = true;
}

/**
 * One wheel notch as a step: -1 back, +1 forward, 0 for anything else.
 *
 * Shared with the overview, which needs the identical mapping for its own
 * scroll seam. Smooth events return 0 here and are meant to: they belong to a
 * swipe tracker, which drives the same value continuously, and stepping it as
 * well would fight the gesture.
 */
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
