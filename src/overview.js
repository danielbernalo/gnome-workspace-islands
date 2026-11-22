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

const TRACKER_NAME = 'workspace-islands overview swipe tracker';

let injector = null;

let gestureView = null;

let gestureDisplay = null;
let shellTracker = null;
let ourTracker = null;

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

// Rebuild with the restored method so no view this extension built outlives it.
function rebuildSecondaryViews(display) {
    for (const monitorDisplay of display?._workspacesViews ?? []) {
        if (monitorDisplay?._workspacesView instanceof VirtualWorkspacesView)
            monitorDisplay._updateWorkspacesView();
    }
}

function workspacesDisplay() {
    return Main.overview?._overview?.controls?._workspacesDisplay ?? null;
}

// Splits a monitor's windows across virtual pages; other Workspaces still hide what we parked.
function patchWindowFilter() {
    const proto = Workspace?.prototype;

    if (!proto || typeof proto._isOverviewWindow !== 'function') {
        console.warn('workspace-islands: Workspace._isOverviewWindow not found — ' +
            'the overview will show windows from inactive workspaces');
        return;
    }

    injector.overrideMethod(proto, '_isOverviewWindow',
        originalMethod => function (window) {
            const virtual = tagFor(this);

            if (virtual) {
                // Untracked windows show with the active workspace, where they are on screen.
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

// For our pages _isMyWindow means "same monitor", so the stock drop refuses moves between them.
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

            virtual.onDrop?.(virtual.index, source.metaWindow, this.monitorIndex);
            return true;
        });
}

// The page click is an unreplaceable closure that asks _shouldLeaveOverview, so switch from there.
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

            // The active page too: the click must replace a switch still animating away from it.
            view.activate(virtual.index);
            return active;
        });

    // A window click asks the same question; on our pages it must still go straight to the window.
    injector.overrideMethod(proto, '_onCloneSelected',
        originalMethod => function (clone, time) {
            if (!tagFor(this)) {
                originalMethod.call(this, clone, time);
                return;
            }

            Main.activateWindow(clone.metaWindow, time);
        });
}

// Shell bug: after an unplug the monitor index is past the list and the clip update throws per page.
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

// With workspaces-only-on-primary, secondaries otherwise get a one-workspace ExtraWorkspaceView.
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

// The _switchWorkspace* handlers are .bind()-captured at startup, so the tracker itself is swapped.
function takeOverGesture(getState, log) {
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

        log(`overview gesture begin on monitor ${monitorIndex}: ` +
            `${view ? 'ours' : 'passing to the shell'}`);

        if (!view) {
            display._switchWorkspaceBegin(t, monitorIndex);
            return;
        }

        // Supersede a snap still in flight instead of committing it.
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

        // The snap is the switch; easing first and activating after could outlive a closing overview.
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

    // Disabled, the scroll gesture destroy() leaves behind propagates events.
    ourTracker.enabled = false;

    // TouchpadSwipeGesture.destroy() only disconnects from global.stage, and ours is on overviewGroup.
    const touchpadGesture = ourTracker._touchpadGesture;
    if (touchpadGesture)
        Main.layoutManager.overviewGroup?.disconnectObject(touchpadGesture);
    ourTracker.destroy();

    gestureDisplay = null;
    shellTracker = null;
    ourTracker = null;
}

// Under workspaces-only-on-primary the shell drops wheel scrolls on secondary monitors.
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

            // Finger scrolling belongs to the swipe tracker; stepping here too would fight it.
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

function monitorIndexOf(event) {
    const [x, y] = event.get_coords();
    const rect = new Mtk.Rectangle({ x, y, width: 1, height: 1 });

    return global.display.get_monitor_index_for_rect(rect);
}

function viewFor(display, monitorIndex, getState) {
    if (monitorIndex === Main.layoutManager.primaryIndex)
        return null;

    if (!getState(monitorIndex))
        return null;

    const view = display._workspacesViews?.[monitorIndex]?._workspacesView;

    return view instanceof VirtualWorkspacesView ? view : null;
}
