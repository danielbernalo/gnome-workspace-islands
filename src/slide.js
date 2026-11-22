import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SwipeTracker from 'resource:///org/gnome/shell/ui/swipeTracker.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import { monitorIndexOf } from './monitorState.js';
import { hide, reveal } from './visibility.js';

// Read off the namespace: the Node test stubs only provide a fixed list of named exports.
const { WINDOW_ANIMATION_TIME, WORKSPACE_SPACING } = WorkspaceAnimation;

const TRACKER_NAME = 'workspace-islands swipe tracker';

// Stacking order, not group order, and only showing windows, so the cover matches the screen.
export function cloneOrder(windows) {
    return global.display.sort_windows_by_stacking(
        windows.filter(window => window.showing_on_its_workspace()));
}

// Opaque by design: the wallpaper hides the real windows that are still unminimized underneath.
const Page = GObject.registerClass(
class IslandsSlidePage extends Clutter.Actor {
    _init(monitor) {
        super._init({
            width: monitor.width,
            height: monitor.height,
            clip_to_allocation: true,
        });

        this._monitor = monitor;
        this._clones = [];

        const background = new Meta.BackgroundGroup();
        this.add_child(background);
        this._backgroundManager = new Background.BackgroundManager({
            container: background,
            monitorIndex: monitor.index,
            controlPosition: false,
        });

        this.connect('destroy', () => this._onDestroy());
    }

    fill(windows) {
        for (const window of cloneOrder(windows))
            this._addClone(window);
    }

    _addClone(window) {
        const actor = window.get_compositor_private();
        if (!actor)
            return;

        const clone = new Clutter.Clone({
            source: actor,
            x: actor.x - this._monitor.x,
            y: actor.y - this._monitor.y,
        });
        this.add_child(clone);

        // A window closed mid-slide would otherwise leave a clone of a dead actor.
        const record = { actor, clone, destroyId: 0 };
        record.destroyId = actor.connect('destroy', () => {
            record.destroyId = 0;
            clone.destroy();
            this._clones.splice(this._clones.indexOf(record), 1);
        });

        this._clones.push(record);
    }

    _onDestroy() {
        for (const record of this._clones) {
            if (record.destroyId)
                record.actor.disconnect(record.destroyId);
        }
        this._clones = [];

        this._backgroundManager?.destroy();
        this._backgroundManager = null;
    }
});

// Known gap: indices are captured at gesture start and do not follow a dynamic-mode renumbering.
const Slide = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.double(
            'progress', null, null,
            GObject.ParamFlags.READWRITE,
            -Infinity, Infinity, 0),
    },
}, class IslandsSlide extends St.Widget {
    _init(monitor, indices) {
        super._init({
            clip_to_allocation: true,
            style_class: 'workspace-animation',
        });

        this._monitor = monitor;
        this.add_constraint(new Layout.MonitorConstraint({ index: monitor.index }));

        this._container = new Clutter.Actor();
        this.add_child(this._container);

        this._pages = [];

        let offset = 0;
        for (const index of indices) {
            const page = new Page(monitor);
            this._container.add_child(page);

            if (this._vertical)
                page.set_position(0, offset);
            else if (this._rtl)
                page.set_position(-offset, 0);
            else
                page.set_position(offset, 0);

            this._pages.push({ index, page });
            offset += this.baseDistance;
        }
    }

    get _vertical() {
        return global.workspace_manager.layout_rows === -1;
    }

    get _rtl() {
        return this.get_text_direction() === Clutter.TextDirection.RTL;
    }

    get baseDistance() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const spacing = WORKSPACE_SPACING * scale;

        return this._vertical
            ? this._monitor.height + spacing
            : this._monitor.width + spacing;
    }

    get progress() {
        if (this._vertical)
            return -this._container.y / this.baseDistance;

        return this._rtl
            ? this._container.x / this.baseDistance
            : -this._container.x / this.baseDistance;
    }

    set progress(value) {
        const offset = Math.round(value * this.baseDistance);

        if (this._vertical)
            this._container.y = -offset;
        else if (this._rtl)
            this._container.x = offset;
        else
            this._container.x = -offset;

        this.notify('progress');
    }

    fill(workspaceIndex, windows) {
        this._pages.find(page => page.index === workspaceIndex)
            ?.page.fill(windows);
    }

    get indices() {
        return this._pages.map(page => page.index);
    }

    // Page positions, not workspace indices: SwipeTracker requires ascending snap points.
    getSnapPoints() {
        return this._pages.map((_page, position) => position);
    }

    progressFor(workspaceIndex) {
        return this._pages.findIndex(page => page.index === workspaceIndex);
    }

    indexAt(progress) {
        const clamped = Math.min(Math.max(progress, 0), this._pages.length - 1);
        return this._pages[Math.round(clamped)].index;
    }
});

export class SlideController {
    // onCommit must not animate, the slide already did; onProgress(state, null) ends the preview.
    constructor({ settings, getState, onCommit, onProgress }) {
        this._settings = settings;
        this._getState = getState;
        this._onCommit = onCommit;
        this._onProgress = onProgress;

        this._session = null;
        this._claimed = false;

        // Overview, lock screen and other modals change actionMode, so the swipe's END never arrives.
        this._signals = [
            [Main.overview, Main.overview.connect('showing',
                () => this._cancel())],
            [Main.sessionMode, Main.sessionMode.connect('updated',
                () => {
                    if (Main.sessionMode.isLocked)
                        this._cancel();
                })],
            [global.stage, global.stage.connect('notify::key-focus',
                () => this._onKeyFocusChanged())],
        ];

        this._takeOverTracker();
    }

    // Shell handlers were .bind()-captured at startup, so swap the tracker; a disabled one propagates.
    _takeOverTracker() {
        const controller = Main.wm?._workspaceAnimation;
        if (!controller?._swipeTracker) {
            console.warn('workspace-islands: no workspace animation swipe tracker, ' +
                'touchpad gesture unavailable');
            return;
        }

        this._controller = controller;
        this._shellTracker = controller._swipeTracker;
        this._shellTracker.enabled = false;

        const tracker = new SwipeTracker.SwipeTracker(
            global.stage,
            Clutter.Orientation.HORIZONTAL,
            Shell.ActionMode.NORMAL,
            {
                allowDrag: false,
                phase: Clutter.EventPhase.CAPTURE,
                name: TRACKER_NAME,
            });

        global.display.bind_property('compositor-modifiers',
            tracker, 'scroll-modifiers', GObject.BindingFlags.SYNC_CREATE);

        this._signals.push(
            [tracker, tracker.connect('begin',
                (t, monitorIndex) => this._onBegin(t, monitorIndex))],
            [tracker, tracker.connect('update',
                (t, progress) => this._onUpdate(t, progress))],
            [tracker, tracker.connect('end',
                (t, duration, endProgress) => this._onEnd(t, duration, endProgress))]);

        this._tracker = tracker;
        controller._swipeTracker = tracker;
    }

    _onBegin(tracker, monitorIndex) {
        if (!this._begin(tracker, monitorIndex))
            this._controller._switchWorkspaceBegin(tracker, monitorIndex);
    }

    _onUpdate(tracker, progress) {
        if (!this._update(progress))
            this._controller._switchWorkspaceUpdate(tracker, progress);
    }

    _onEnd(tracker, duration, endProgress) {
        if (!this._end(duration, endProgress))
            this._controller._switchWorkspaceEnd(tracker, duration, endProgress);
    }

    _restoreTracker() {
        if (!this._controller)
            return;

        this._controller._swipeTracker = this._shellTracker;
        this._shellTracker.enabled = true;
        this._shellTracker = null;

        if (this._tracker) {
            // Disable first: destroy() cannot disconnect the scroll gesture, which then propagates.
            this._tracker.enabled = false;
            this._tracker.destroy();
            this._tracker = null;
        }

        this._controller = null;
    }

    // Returns false when no slide ran and the caller must apply the switch itself.
    animateSwitch(state, index, forward) {
        if (!this._settings?.get_boolean('switch-animation'))
            return false;

        // A gesture in flight owns the monitor; never stack a second cover over it.
        if (this._session)
            return false;

        // Page order is direction: shortcuts wrap, so last-to-first must still slide forward.
        const pages = forward === undefined
            ? [state.activeIndex, index].sort((a, b) => a - b)
            : forward
                ? [state.activeIndex, index]
                : [index, state.activeIndex];

        const session = this._prepare(state, pages, false);
        if (!session)
            return false;

        session.slide.ease_property(
            'progress', session.slide.progressFor(index), {
                duration: WINDOW_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => this._finish(index),
            });

        return true;
    }

    destroy() {
        this._cancel();
        this._restoreTracker();

        for (const [object, id] of this._signals ?? [])
            object.disconnect(id);
        this._signals = [];

        this._settings = null;
        this._getState = null;
    }

    // One synchronous block: Clutter paints at frame boundaries, so half-built states never show.
    _prepare(state, indices, gesture) {
        const monitorIndex = monitorIndexOf(state.connector);
        if (monitorIndex < 0)
            return null;

        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor)
            return null;

        const pages = [...new Set(indices)]
            .filter(index => index >= 0 && index < state.size);

        if (pages.length < 2)
            return null;

        const slide = new Slide(monitor, pages);
        Main.uiGroup.insert_child_above(slide, global.window_group);

        // An unredirected fullscreen window would bypass the stage and hide the slide.
        global.compositor.disable_unredirect();

        // Minimized windows clone blank, so neighbours are revealed only once the cover is up.
        slide.fill(state.activeIndex, state.windowsOn(state.activeIndex));

        const revealed = [];
        for (const index of pages) {
            if (index === state.activeIndex)
                continue;

            const windows = state.windowsOn(index);
            for (const window of windows) {
                reveal(window);
                revealed.push(window);
            }

            slide.fill(index, windows);
        }

        slide.progress = slide.progressFor(state.activeIndex);

        this._session = { state, slide, revealed, gesture };
        return this._session;
    }

    // Commit while the cover is still up so no minimize animation shows, then drop the cover.
    _finish(index) {
        const session = this._session;
        if (!session)
            return;

        this._session = null;
        this._claimed = false;

        this._onCommit(session.state, index, { gesture: session.gesture });

        // Not index: switchTo() may have collapsed an empty workspace and renumbered the rest.
        this._settle(session, session.state.activeIndex);
        this._teardown(session);
    }

    // For layout changes and locking; call before pruneDetached(), while groups still exist.
    cancel() {
        this._cancel();
    }

    _cancel() {
        const session = this._session;
        if (!session)
            return;

        const claimed = this._claimed;
        this._session = null;
        this._claimed = false;

        this._settle(session, session.state.activeIndex);
        this._teardown(session);

        if (claimed)
            this._resetTracker();
    }

    // Toggling enabled makes SwipeTracker interrupt a swipe whose END was dropped; needs no session.
    _resetTracker() {
        if (!this._tracker?.enabled)
            return;

        this._tracker.enabled = false;
        this._tracker.enabled = true;
    }

    // There is no actionMode signal; pushModal() sets it and then moves key focus.
    _onKeyFocusChanged() {
        if (this._claimed && (Main.actionMode & Shell.ActionMode.NORMAL) === 0)
            this._cancel();
    }

    // switchTo() only touches the left and entered workspaces; a third preview must be re-hidden.
    _settle(session, index) {
        for (const window of session.revealed) {
            if (session.state.indexOf(window) !== index)
                hide(window, { animate: false });
        }
    }

    _teardown(session) {
        session.slide.destroy();
        global.compositor.enable_unredirect();

        this._onProgress(session.state, null);
    }

    _begin(tracker, monitorIndex) {
        this._claimed = false;

        if (!this._settings?.get_boolean('touchpad-gesture'))
            return false;

        if (monitorIndex === Main.layoutManager.primaryIndex)
            return false;

        if (this._session) {
            // Adopt only on the slide's monitor; the pointer may not be where a keyboard slide runs.
            if (this._getState(monitorIndex) !== this._session.state)
                return false;

            // Dropping the transition drops its committing onComplete; an adopted slide lands without OSD.
            this._session.slide.remove_all_transitions();
            this._session.gesture = true;
        } else {
            const state = this._getState(monitorIndex);
            if (!state || state.size < 2)
                return false;

            const active = state.activeIndex;
            if (!this._prepare(state, [active - 1, active, active + 1], true))
                return false;
        }

        const { slide } = this._session;

        tracker.orientation = global.workspace_manager.layout_rows === -1
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;

        const progress = slide.progress;
        const cancelProgress = slide.progressFor(slide.indexAt(progress));

        tracker.confirmSwipe(
            slide.baseDistance, slide.getSnapPoints(), progress, cancelProgress);

        this._claimed = true;
        return true;
    }

    _update(progress) {
        const session = this._session;
        if (!session || !this._claimed)
            return false;

        session.slide.progress = progress;

        this._onProgress(session.state, previewIndex(session.slide, progress));
        return true;
    }

    _end(duration, endProgress) {
        const session = this._session;
        if (!session || !this._claimed)
            return false;

        this._claimed = false;

        const index = session.slide.indexAt(endProgress);

        session.slide.ease_property('progress', endProgress, {
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => this._finish(index),
        });

        return true;
    }
}

// Interpolate through the page list: pages may be non-contiguous, e.g. a wrapped [3, 0].
function previewIndex(slide, progress) {
    const indices = slide.indices;
    const last = indices.length - 1;

    const clamp = position => Math.min(Math.max(position, 0), last);
    const lower = Math.floor(progress);
    const from = indices[clamp(lower)];
    const to = indices[clamp(Math.ceil(progress))];

    return from + (to - from) * (progress - lower);
}
