/**
 * Overview integration: the seams, not the widgets.
 *
 * Everything drawn lives in workspacesView.js. This module is only the set of
 * shell methods that have to be intercepted to get it on screen, kept in one
 * place because the list of them *is* the maintenance burden — when a GNOME
 * update breaks this extension, it will almost certainly break here.
 *
 * There are five, and one of them is not an override at all — see the swipe.
 *
 * ## Workspace._isOverviewWindow — which page a window belongs to
 *
 * The overview shows every window on a workspace, minimized ones included; the
 * method is only `!window.skip_taskbar`. `Workspace._isMyWindow` with a null
 * MetaWorkspace means "is it on this monitor", so every page starts from the
 * same candidate set and this predicate is enough to split them apart. Each
 * page carries a tag and the override reads it off `this`.
 *
 * For any Workspace we did not build — the primary monitor's, or a secondary
 * one we do not manage — it keeps its old job of hiding what we parked.
 *
 * ## Workspace._shouldLeaveOverview — what clicking a page means
 *
 * A page with no MetaWorkspace always answers "leave", so clicking the
 * neighbour peeking in at the edge closed the overview where it was instead of
 * switching to it, the way the primary monitor does. Asked of a virtual page,
 * it now switches and stays. `_onCloneSelected` asks the same question for a
 * window click, which keeps going straight to its window.
 *
 * ## SecondaryMonitorDisplay._updateWorkspacesView — which view to build
 *
 * With `workspaces-only-on-primary` on, secondary monitors always get an
 * `ExtraWorkspaceView`: one workspace, no scrolling, no thumbnails. Replaced
 * with the ported view.
 *
 * ## The swipe tracker — replaced, not overridden
 *
 * `_switchWorkspaceBegin` declines non-primary monitors without calling
 * `confirmSwipe()`, and one layer down `TouchpadSwipeGesture` has already
 * claimed the event and returns `Clutter.EVENT_STOP` regardless — so simply
 * adding a second tracker would never see an event.
 *
 * Overriding those three methods does not work either, silently: they are
 * connected with `.bind(this)` at construction, which captures the original
 * function object before any extension exists. The whole tracker is swapped
 * instead. See takeOverGesture below, and slide.js for the same trap outside
 * the overview.
 *
 * ## WorkspacesDisplay._onScrollEvent — the wheel, and two fingers
 *
 * A separate path from the swipe, and it fails separately. Scrolling splits in
 * two before it ever reaches the code above:
 *
 *     _onScrollEvent(actor, event) {
 *         if (this._swipeTracker.canHandleScrollEvent(event))
 *             return Clutter.EVENT_PROPAGATE;      // finger scroll -> tracker
 *         ...
 *         if (this._workspacesOnlyOnPrimary &&
 *             this._getMonitorIndexForEvent(event) !== this._primaryIndex)
 *             return Clutter.EVENT_PROPAGATE;      // wheel on secondary: dead
 *         return Main.wm.handleWorkspaceScroll(event);
 *     }
 *
 * `ScrollGesture.canHandleEvent` requires a FINGER scroll source or a touchpad
 * device, so a mouse wheel never takes the first branch and dies on the second.
 * Two fingers do take the first branch and arrive as a normal gesture.
 *
 * The override handles the wheel itself and leaves finger scrolling to the
 * tracker, which is where it belongs — one keeps its discrete step, the other
 * keeps following your fingers.
 */

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as SwipeTracker from 'resource:///org/gnome/shell/ui/swipeTracker.js';
import { Workspace, WorkspaceBackground } from 'resource:///org/gnome/shell/ui/workspace.js';
import {
    SecondaryMonitorDisplay,
    WorkspacesDisplay,
} from 'resource:///org/gnome/shell/ui/workspacesView.js';

import { isHiddenByUs } from './visibility.js';
import { scrollDelta } from './scroll.js';
import { VirtualWorkspacesView, tagFor } from './workspacesView.js';

/** Identifies the replacement action on the group; SwipeTracker uses it too. */
const TRACKER_NAME = 'workspace-islands overview swipe tracker';

let injector = null;

/** The view that owns the gesture in flight, if any. */
let gestureView = null;

/** Set while the overview's swipe tracker is ours. */
let gestureDisplay = null;
let shellTracker = null;
let ourTracker = null;

/**
 * @param {object} opts
 * @param {(monitorIndex: number) => (object|null)} opts.getState MonitorState
 *   for a monitor, or null for the primary and anything unmanaged
 * @param {(state: object, index: number) => void} opts.onActivate commit a
 *   switch chosen from inside the overview
 * @param {(state: object, index: number, window: Meta.Window, monitorIndex: number) => void} opts.onDrop
 * @param {(message: string) => void} opts.log honours debug-logging
 */
export function patch({ getState, onActivate, onDrop, log }) {
    injector = new InjectionManager();

    patchWindowFilter();
    patchDropTarget();
    patchPageClick();
    patchOrphanedBackground();
    patchSecondaryView(getState, onActivate, onDrop);
    takeOverGesture(getState, log);
    patchScroll(getState, log);
}

export function unpatch() {
    // Captured before restoreGesture() clears it.
    const display = gestureDisplay ?? workspacesDisplay();

    restoreGesture();

    injector?.clear();
    injector = null;
    gestureView = null;

    rebuildSecondaryViews(display);
}

/**
 * Hand every secondary monitor back to the shell's own view.
 *
 * Clearing the injections restores `_updateWorkspacesView`, so asking each
 * display to rebuild destroys what this module built and puts an
 * `ExtraWorkspaceView` back in its place.
 *
 * Not housekeeping. A view left behind holds N Workspace pages, a background
 * manager per thumbnail and possibly a pending idle — objects an extension
 * created, outliving the extension, which is the one thing the review
 * guidelines are unambiguous about.
 */
function rebuildSecondaryViews(display) {
    for (const monitorDisplay of display?._workspacesViews ?? []) {
        if (monitorDisplay?._workspacesView instanceof VirtualWorkspacesView)
            monitorDisplay._updateWorkspacesView();
    }
}

/** Two private hops; `controls` is a public getter, the display beyond is not. */
function workspacesDisplay() {
    return Main.overview?._overview?.controls?._workspacesDisplay ?? null;
}

function patchWindowFilter() {
    const proto = Workspace?.prototype;

    // Degrade to "the overview shows everything", never to a broken shell.
    if (!proto || typeof proto._isOverviewWindow !== 'function') {
        console.warn('workspace-islands: Workspace._isOverviewWindow not found — ' +
            'the overview will show windows from inactive workspaces');
        return;
    }

    injector.overrideMethod(proto, '_isOverviewWindow',
        originalMethod => function (window) {
            const virtual = tagFor(this);

            if (virtual) {
                // Untracked windows belong nowhere in the model, and belonging
                // nowhere would mean appearing on no page at all. They show up
                // with the active workspace, which is where they are on screen.
                const index = virtual.state.indexOf(window);
                const page = index === -1 ? virtual.state.activeIndex : index;

                return page === virtual.index &&
                    originalMethod.call(this, window);
            }

            if (isHiddenByUs(window))
                return false;

            return originalMethod.call(this, window);
        });
}

/**
 * Let a page accept a window dragged onto it.
 *
 * `Workspace` is already a drop target, and already refuses ours:
 *
 *     acceptDrop(source, ...) {
 *         if (this._isMyWindow(window))
 *             return false;
 *
 * With a null MetaWorkspace `_isMyWindow` means "is it on this monitor", which
 * is true of every window on every one of our pages — so a drop between two of
 * them is rejected, and `handleDragOver` never even offers the move cursor.
 * Comparing virtual workspaces instead of monitors is the whole fix.
 *
 * In practice the strip is the reachable target, since only one page is on
 * screen at a time. This matters for the other direction: dragging a window in
 * from the primary monitor onto the page you are looking at.
 */
function patchDropTarget() {
    const proto = Workspace?.prototype;

    if (!proto || typeof proto.acceptDrop !== 'function') {
        console.warn('workspace-islands: Workspace drop handlers not found — ' +
            'windows cannot be dragged between virtual workspaces');
        return;
    }

    injector.overrideMethod(proto, 'handleDragOver',
        originalMethod => function (source, actor, x, y, time) {
            const virtual = tagFor(this);

            if (virtual && source?.metaWindow) {
                return virtual.state.indexOf(source.metaWindow) === virtual.index
                    ? DND.DragMotionResult.CONTINUE
                    : DND.DragMotionResult.MOVE_DROP;
            }

            return originalMethod.call(this, source, actor, x, y, time);
        });

    injector.overrideMethod(proto, 'acceptDrop',
        originalMethod => function (source, actor, x, y, time) {
            const virtual = tagFor(this);

            if (!virtual || !source?.metaWindow)
                return originalMethod.call(this, source, actor, x, y, time);

            if (virtual.state.indexOf(source.metaWindow) === virtual.index)
                return false;

            // The callback rides on the tag, because that is the only thing a
            // page carries that this module put there.
            virtual.onDrop?.(virtual.index, source.metaWindow, this.monitorIndex);
            return true;
        });
}

/**
 * Make a click on a neighbouring page switch to it, as on the primary monitor.
 *
 * The page's click handler is a closure built in `Workspace._init`, so it
 * cannot be replaced — but it decides through a live method lookup:
 *
 *     const leaveOverview = this._shouldLeaveOverview();
 *     this.metaWorkspace?.activate(global.get_current_time());
 *     if (leaveOverview)
 *         Main.overview.hide();
 *
 * and `_shouldLeaveOverview` returns true outright when `metaWorkspace` is
 * null, which every virtual page's is. So the switch is made here, as the side
 * effect the shell gets from `metaWorkspace.activate()`, and the answer is
 * "stay". The shell's other two rules are kept: the centred page and anything
 * clicked from the app grid still leave the overview.
 *
 * The view is reached through the page's parent rather than a callback on the
 * tag. Every page is a direct child of its view, rebuilt ones included, so
 * this needs nothing from the code that builds them.
 */
function patchPageClick() {
    const proto = Workspace?.prototype;

    if (!proto || typeof proto._shouldLeaveOverview !== 'function' ||
        typeof proto._onCloneSelected !== 'function') {
        console.warn('workspace-islands: Workspace._shouldLeaveOverview not found — ' +
            'clicking a neighbouring page will close the overview instead of switching');
        return;
    }

    injector.overrideMethod(proto, '_shouldLeaveOverview',
        originalMethod => function () {
            const virtual = tagFor(this);
            if (!virtual)
                return originalMethod.call(this);

            const active = virtual.index === virtual.state.activeIndex;

            if (this._overviewAdjustment.value >
                OverviewControls.ControlsState.WINDOW_PICKER)
                return true;

            const view = this.get_parent();
            if (!(view instanceof VirtualWorkspacesView))
                return true;

            // The active page too, not only a neighbour. A switch can still be
            // animating away from it, and the view commits that switch when
            // the overview closes; a click here means "this one", so it has
            // to replace the switch in flight, and committing the active
            // index is a no-op.
            view.activate(virtual.index);
            return active;
        });

    // A window click asks the same question, and "stay" would turn it into a
    // workspace switch. For a virtual page it keeps doing what it did before
    // the override above existed — the original's answer was always "leave" —
    // and goes to the window, whose un-minimize brings its workspace along.
    // Bound per clone as the clone is created, which is after this is in place.
    injector.overrideMethod(proto, '_onCloneSelected',
        originalMethod => function (clone, time) {
            if (!tagFor(this)) {
                originalMethod.call(this, clone, time);
                return;
            }

            Main.activateWindow(clone.metaWindow, time);
        });
}

/**
 * Stop a background from reading the geometry of a monitor that just left.
 *
 * `WorkspaceBackground` keeps a monitor index and connects `workareas-changed`
 * to recompute its rounded clip against `Main.layoutManager.monitors[index]`.
 * Unplug that monitor and the signal arrives while the index is already past
 * the end of the list, so the handler dereferences `undefined` and throws
 * before anything gets round to destroying the view.
 *
 * This is the shell's own code and the shell's own bug — its single
 * `ExtraWorkspaceView` per secondary monitor hits it too, once, which is quiet
 * enough that nobody has chased it. What makes it worth patching from here is
 * that this extension gives a secondary monitor one page per virtual
 * workspace, so the same unplug throws once per page: four JS errors and a
 * wall of allocation warnings on every dock, all of them pointing at shell
 * files and none of them mentioning this extension. A future maintainer
 * reading that journal would have no reason to suspect us and every reason to
 * lose an evening.
 *
 * Returning early is the whole fix. The view is about to be rebuilt against
 * the new layout, so there is no clip worth computing and nothing downstream
 * of it that survives.
 */
function patchOrphanedBackground() {
    const proto = WorkspaceBackground?.prototype;

    if (!proto || typeof proto._updateRoundedClipBounds !== 'function') {
        console.warn('workspace-islands: WorkspaceBackground._updateRoundedClipBounds ' +
            'not found — unplugging a monitor will log harmless JS errors');
        return;
    }

    injector.overrideMethod(proto, '_updateRoundedClipBounds',
        originalMethod => function () {
            if (!Main.layoutManager.monitors[this._monitorIndex])
                return;

            originalMethod.call(this);
        });
}

function patchSecondaryView(getState, onActivate, onDrop) {
    const proto = SecondaryMonitorDisplay?.prototype;

    if (!proto || typeof proto._updateWorkspacesView !== 'function') {
        console.warn('workspace-islands: SecondaryMonitorDisplay._updateWorkspacesView ' +
            'not found — the overview will show one workspace per secondary monitor');
        return;
    }

    injector.overrideMethod(proto, '_updateWorkspacesView',
        originalMethod => function () {
            const state = getState(this._monitorIndex);

            // Meta's public accessor rather than the display's own _settings:
            // one less private field to be wrong about.
            if (!state || state.size < 2 ||
                !Meta.prefs_get_workspaces_only_on_primary()) {
                originalMethod.call(this);
                return;
            }

            this._workspacesView?.destroy();
            this._workspacesView = new VirtualWorkspacesView(
                this._monitorIndex,
                this._overviewAdjustment,
                state,
                index => onActivate(state, index),
                (index, window, monitorIndex) =>
                    onDrop(state, index, window, monitorIndex));

            this.add_child(this._workspacesView);
        });
}

/**
 * Replace the overview's swipe tracker with one whose handlers are ours.
 *
 * Overriding `_switchWorkspaceBegin` does not work, and the failure is silent.
 * `WorkspacesDisplay._init` connects with
 *
 *     this._swipeTracker.connect('begin', this._switchWorkspaceBegin.bind(this));
 *
 * and `.bind()` captures the function object at construction time — shell
 * startup, long before an extension is enabled. The override installs, reports
 * success, and is never reached, because the handler still points at the
 * original. slide.js hit the identical trap outside the overview.
 *
 * Disabling the shell's tracker is what frees the events: a disabled tracker's
 * gestures return EVENT_PROPAGATE rather than swallowing them with EVENT_STOP.
 * The replacement goes on `display._swipeTracker`, where the shell's own
 * `_updateSwipeTracker` and `_updateTrackerOrientation` keep managing it.
 */
function takeOverGesture(getState, log) {
    // Two private hops. `controls` is a public getter — the shell reaches
    // through it the same way in overview.js — but the display beyond it is not.
    const display = workspacesDisplay();

    if (!display?._swipeTracker) {
        console.warn('workspace-islands: overview swipe tracker not found — ' +
            'the overview gesture will not work on secondary monitors');
        return;
    }

    shellTracker = display._swipeTracker;
    shellTracker.enabled = false;

    const tracker = new SwipeTracker.SwipeTracker(
        Main.layoutManager.overviewGroup,
        Clutter.Orientation.HORIZONTAL,
        Shell.ActionMode.OVERVIEW,
        {
            allowDrag: false,
            name: TRACKER_NAME,
        });
    tracker.allowLongSwipes = true;

    tracker.connect('begin', (t, monitorIndex) => {
        gestureView = null;

        const view = viewFor(display, monitorIndex, getState);

        // Both touchpad paths land here — a three-finger swipe, and a
        // two-finger scroll the tracker adopted from a scroll event.
        log(`overview gesture begin on monitor ${monitorIndex}: ` +
            `${view ? 'ours' : 'passing to the shell'}`);

        if (!view) {
            display._switchWorkspaceBegin(t, monitorIndex);
            return;
        }

        // Supersedes a snap still in flight instead of committing it: this
        // gesture ends with a target of its own.
        view.cancelSwitch();
        const adjustment = view.scrollAdjustment;

        t.orientation = global.workspace_manager.layout_rows === -1
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;

        const distance = t.orientation === Clutter.Orientation.VERTICAL
            ? view.height : view.width;

        const points = Array.from({ length: view.pageCount }, (_v, i) => i);
        const progress = adjustment.value;

        t.confirmSwipe(distance, points, progress, Math.round(progress));

        gestureView = view;
    });

    tracker.connect('update', (t, progress) => {
        if (!gestureView) {
            display._switchWorkspaceUpdate(t, progress);
            return;
        }

        gestureView.scrollAdjustment.value = progress;
    });

    tracker.connect('end', (t, duration, endProgress) => {
        const view = gestureView;
        if (!view) {
            display._switchWorkspaceEnd(t, duration, endProgress);
            return;
        }

        gestureView = null;

        // The snap itself is the switch animation, at the tracker's duration.
        // Easing first and activating after would chain a second ease, and
        // the commit with it, well past an overview that may close meanwhile.
        view.activate(Math.round(endProgress), duration);
    });

    ourTracker = tracker;
    gestureDisplay = display;
    display._swipeTracker = tracker;
}

function restoreGesture() {
    if (!gestureDisplay)
        return;

    gestureDisplay._swipeTracker = shellTracker;
    shellTracker.enabled = true;

    // See slide.js for why disabling comes before destroying.
    ourTracker.enabled = false;

    // TouchpadSwipeGesture connects 'event::touchpad' to the actor it was
    // given but its destroy() disconnects from global.stage only. Ours is on
    // overviewGroup, so without this every enable leaves one more handler
    // there for the rest of the session. One private hop, to the object that
    // owns the connection.
    const touchpadGesture = ourTracker._touchpadGesture;
    if (touchpadGesture)
        Main.layoutManager.overviewGroup?.disconnectObject(touchpadGesture);
    ourTracker.destroy();

    gestureDisplay = null;
    shellTracker = null;
    ourTracker = null;
}

function patchScroll(getState, log) {
    const proto = WorkspacesDisplay?.prototype;

    if (!proto || typeof proto._onScrollEvent !== 'function') {
        console.warn('workspace-islands: WorkspacesDisplay._onScrollEvent not found — ' +
            'scrolling will not switch workspaces on secondary monitors');
        return;
    }

    injector.overrideMethod(proto, '_onScrollEvent',
        originalMethod => function (actor, event) {
            const view = viewFor(this, monitorIndexOf(event), getState);
            if (!view)
                return originalMethod.call(this, actor, event);

            // Finger scrolling belongs to the swipe tracker, which drives the
            // same adjustment continuously. Stepping it here as well would
            // fight the gesture for the same value.
            if (this._swipeTracker?.canHandleScrollEvent(event))
                return Clutter.EVENT_PROPAGATE;

            const delta = scrollDelta(event);
            if (delta === 0)
                return Clutter.EVENT_PROPAGATE;

            const from = Math.round(view.scrollAdjustment.value);
            const to = Math.min(Math.max(from + delta, 0), view.pageCount - 1);

            log(`overview scroll on monitor ${monitorIndexOf(event)}: ` +
                `${from} -> ${to}`);

            if (to !== from)
                view.activate(to);

            return Clutter.EVENT_STOP;
        });
}

/** -1, 1 or 0 for anything that is not a discrete step. */

/** Same computation as WorkspacesDisplay._getMonitorIndexForEvent, in public API. */
function monitorIndexOf(event) {
    const [x, y] = event.get_coords();
    const rect = new Mtk.Rectangle({ x, y, width: 1, height: 1 });

    return global.display.get_monitor_index_for_rect(rect);
}

/**
 * The view a gesture beginning on this monitor should drive, or null when the
 * shell should keep it.
 */
function viewFor(display, monitorIndex, getState) {
    if (monitorIndex === Main.layoutManager.primaryIndex)
        return null;

    if (!getState(monitorIndex))
        return null;

    const view = display._workspacesViews?.[monitorIndex]?._workspacesView;

    return view instanceof VirtualWorkspacesView ? view : null;
}
