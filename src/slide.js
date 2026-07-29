/**
 * Sliding workspace switches, and the touchpad gesture that drives them.
 *
 * These are one module because in GNOME they are one mechanism. A swipe does
 * not "trigger an animation": it writes a fractional progress value, and both
 * the sliding windows and the stretching panel dots read that same number
 * (`workspaceAnimation.js` binds `MonitorGroup.progress` to the very adjustment
 * `panel.js` renders). Split them and you get two things that agree most of the
 * time, which is exactly what a native-feeling switch is not.
 *
 * ## Riding the shell's tracker, not adding one
 *
 * `WorkspaceAnimationController._switchWorkspaceBegin` opens with:
 *
 *     if (Meta.prefs_get_workspaces_only_on_primary() &&
 *         monitor !== Main.layoutManager.primaryIndex)
 *         return;
 *
 * It returns without calling `confirmSwipe()`, and swipeTracker.js documents
 * that an unconfirmed swipe is ignored — so a three-finger swipe over a
 * secondary monitor currently does nothing. It is tempting to read that as free
 * territory and simply add a second SwipeTracker. That does not work, and the
 * reason is one layer down.
 *
 * `TouchpadSwipeGesture` connects with `actor.connectObject('event::touchpad')`
 * and ends with:
 *
 *     return this._state === TouchpadState.HANDLING
 *         ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
 *
 * It enters HANDLING on orientation alone — it knows nothing about monitors. So
 * the shell's gesture claims every three-finger swipe, has its `begin` declined
 * by the controller above, and *still* returns EVENT_STOP. Emission of `event`
 * stops at the first handler returning true, and the shell connected at startup
 * while an extension connects at enable(). A second tracker would never see a
 * single event.
 *
 * Overriding the controller's three swipe handlers does not work either, and
 * the reason is worth writing down because it is invisible and cost a full
 * debugging cycle. `WorkspaceAnimationController` connects them like this:
 *
 *     swipeTracker.connect('begin', this._switchWorkspaceBegin.bind(this));
 *
 * `.bind()` resolves the method and captures that function object at
 * construction time — which is shell startup, long before any extension is
 * enabled. Replacing the method afterwards, on the prototype or on the
 * instance, leaves the already-bound handler pointing at the original. The
 * override installs cleanly, reports success, and is never called.
 *
 * So the tracker itself is replaced. The shell's is disabled, which makes its
 * gestures return `EVENT_PROPAGATE` instead of swallowing the event, and a new
 * one takes its place on `controller._swipeTracker` — where the shell's own
 * `_updateSwipeTracker` and `_updateTrackerOrientation` keep managing it. A
 * gesture on a secondary monitor is handled here; anything else is handed to
 * the controller's original methods, which are untouched.
 *
 * ## Why clones, after all that
 *
 * The README claims no clones, and a slide breaks that claim: windows cannot be
 * moved outside their monitor, so showing two workspaces side by side means
 * cloning them. The difference from PaperWM is lifetime — these exist for the
 * ~250ms of the switch and die with the cover. Not a rendering pipeline, a
 * transition.
 *
 * ## The trap the hide strategy sets
 *
 * `Clutter.Clone` paints its source, and a minimized window's actor paints
 * nothing. The incoming workspace is minimized, so there is nothing to clone
 * until it is brought back; the outgoing one goes blank the instant it is
 * minimized. Hence the order in _prepare and _finish, which is the only one
 * that avoids both:
 *
 *   1. build the cover with wallpaper-only pages and put it on stage
 *   2. fill the active page — the screen now looks untouched
 *   3. un-minimize the neighbours *behind* the cover, and clone them
 *   4. slide
 *   5. commit with animations suppressed, then drop the cover
 *
 * Steps 1-3 are one synchronous block on purpose. Clutter paints at frame
 * boundaries, so nothing half-built is ever drawn.
 *
 * ## Three pages, and why that is not a shortcut
 *
 * Only `[active - 1, active, active + 1]` are prepared. That is not a
 * simplification of GNOME's behaviour, it *is* GNOME's behaviour:
 * `SwipeTracker._getBounds` clamps progress to one snap point either side
 * unless `allowLongSwipes` is set, and the workspace tracker never sets it.
 *
 * Edges do not wrap, matching native workspaces. The keyboard shortcuts still
 * wrap — they always did, and a wrapped *slide* would animate forwards into a
 * workspace that is logically behind you.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SwipeTracker from 'resource:///org/gnome/shell/ui/swipeTracker.js';
import {
    WINDOW_ANIMATION_TIME,
    WORKSPACE_SPACING,
} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import { monitorIndexOf } from './monitorState.js';
import { hide, reveal } from './visibility.js';

/** Identifies the replacement action on the stage; SwipeTracker uses it too. */
const TRACKER_NAME = 'workspace-islands swipe tracker';

/**
 * One workspace, drawn as wallpaper plus clones.
 *
 * Opaque by construction, and that is its whole job. The real windows are still
 * underneath — the outgoing set has not been minimized yet, the incoming set
 * was just un-minimized — and the wallpaper is what keeps that invisible.
 *
 * Built empty and filled later, because the cover has to reach the stage before
 * a single window is revealed behind it.
 */
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
        for (const window of windows)
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

        // A window closed mid-slide would leave a clone pointing at a dead
        // actor. Rare, and fatal enough to be worth the bookkeeping.
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

/**
 * The pages laid out in a row (or column), and the progress that scrolls them.
 *
 * `progress` is a GObject property so it can be eased and bound — which is what
 * lets a swipe and a keypress drive the identical code path.
 */
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

    /** Workspace indices, in page order. */
    get indices() {
        return this._pages.map(page => page.index);
    }

    /** Snap points, ascending, as SwipeTracker requires. */
    getSnapPoints() {
        return this._pages.map((_page, position) => position);
    }

    progressFor(workspaceIndex) {
        return this._pages.findIndex(page => page.index === workspaceIndex);
    }

    /** Workspace index for a progress value, snapped to the nearest page. */
    indexAt(progress) {
        const clamped = Math.min(Math.max(progress, 0), this._pages.length - 1);
        return this._pages[Math.round(clamped)].index;
    }
});

export class SlideController {
    /**
     * @param {object} opts
     * @param {Gio.Settings} opts.settings
     * @param {(monitorIndex: number) => (object|null)} opts.getState
     * @param {(state: object, index: number, info: {gesture: boolean}) => void}
     *   opts.onCommit applies the state change; must not animate, the slide
     *   already did. `gesture` distinguishes a swipe from a keypress — the
     *   shell announces the second with an OSD and the first without one.
     * @param {(state: object, progress: number|null) => void} opts.onProgress
     *   live feedback for the indicator; null ends the preview
     */
    constructor({ settings, getState, onCommit, onProgress }) {
        this._settings = settings;
        this._getState = getState;
        this._onCommit = onCommit;
        this._onProgress = onProgress;

        this._session = null;
        this._claimed = false;

        // The overview owns the whole screen while it is up, secondary
        // monitors included. The shell already disables its tracker there, so
        // the gesture stops on its own; only a running slide needs dropping.
        //
        // The lock screen is the same shape of problem with a worse ending. The
        // shield takes a modal grab, Main.actionMode becomes LOCK_SCREEN, and
        // SwipeTracker drops events that do not match its allowed modes before
        // it ever emits 'end'. Nothing finishes the gesture: _session stays
        // set, so sliding is dead for the rest of the session, the cover stays
        // on the stage, and disable_unredirect() is never balanced. Until this
        // extension declared unlock-dialog, being disabled on lock hid that.
        this._signals = [
            [Main.overview, Main.overview.connect('showing',
                () => this._cancel())],
            [Main.sessionMode, Main.sessionMode.connect('updated',
                () => {
                    if (Main.sessionMode.isLocked)
                        this._cancel();
                })],
        ];

        this._takeOverTracker();
    }

    /**
     * Replace the controller's swipe tracker with one whose handlers are ours.
     *
     * Disabling the shell's is what frees the events: a disabled SwipeTracker's
     * gestures return EVENT_PROPAGATE instead of EVENT_STOP, so the replacement
     * — attached to the same actor, later — actually receives them.
     *
     * Anything unexpected leaves the gesture off rather than taking the
     * extension down with it.
     */
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

    /**
     * Ours, or the shell's.
     *
     * Delegation calls the controller's own methods, which are not patched —
     * they behave exactly as they would have if this module were not loaded.
     */
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
            this._tracker.enabled = false;

        // SwipeTracker.destroy() is the shell's own teardown: it destroys the
        // touchpad gesture and lifts the pan action off the actor. It does not
        // reach the scroll gesture — upstream connects that one with a plain
        // `connect` and discards the handler id, so nobody can disconnect it.
        // Disabling first is what makes that leftover inert: every gesture
        // returns EVENT_PROPAGATE when the tracker is disabled.
            this._tracker.destroy();
            this._tracker = null;
        }

        this._controller = null;
    }

    /**
     * Slide to `index`, then commit.
     *
     * @returns {boolean} false when no slide was possible, and the caller
     *   should apply the switch itself
     */
    animateSwitch(state, index, forward) {
        if (!this._settings?.get_boolean('switch-animation'))
            return false;

        // A gesture in flight owns the monitor. Let it finish rather than
        // stacking a second cover over the first.
        if (this._session)
            return false;

        // Page order is direction, and the shortcuts wrap where native
        // workspaces do not. Going forward from the last workspace to the first
        // has to slide forward; ordering those two numerically would animate
        // backwards into the workspace you just asked to leave.
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

    /**
     * Build the cover, then bring the neighbouring workspaces back behind it.
     *
     * One synchronous block from the first actor to the last clone. Clutter
     * paints at frame boundaries, so the intermediate states — a cover of bare
     * wallpaper, windows un-minimized but not yet cloned — are never drawn.
     */
    _prepare(state, indices, gesture) {
        const monitorIndex = monitorIndexOf(state.connector);
        if (monitorIndex < 0)
            return null;

        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor)
            return null;

        // Caller order is kept: it encodes the direction of travel. Snap points
        // are page *positions*, so they stay ascending no matter which
        // workspace sits at each one, and SwipeTracker's contract holds.
        const pages = [...new Set(indices)]
            .filter(index => index >= 0 && index < state.size);

        if (pages.length < 2)
            return null;

        const slide = new Slide(monitor, pages);
        Main.uiGroup.insert_child_above(slide, global.window_group);

        // A fullscreen window on this monitor would otherwise have the
        // compositor bypassing the stage, and the slide would never be drawn.
        global.compositor.disable_unredirect();

        // The page under the cover goes first, so the screen keeps looking
        // exactly like the screen.
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

    /**
     * Commit the switch and take the cover down.
     *
     * Order is load-bearing twice: the state change happens while the cover is
     * still up, so no minimize animation is ever seen, and the cover comes down
     * only afterwards, so no clone is emptied while still on screen.
     */
    _finish(index) {
        const session = this._session;
        if (!session)
            return;

        this._session = null;
        this._claimed = false;

        this._onCommit(session.state, index, { gesture: session.gesture });

        // Not `index`: onCommit's switchTo() may have just collapsed an empty
        // workspace and shifted everything after it, including the one we
        // landed on. state.activeIndex is the one value guaranteed to still
        // point at it — session.state.indexOf() below has to agree with the
        // same numbering, or a page that's actually current gets re-hidden.
        this._settle(session, session.state.activeIndex);
        this._teardown(session);
    }

    /**
     * Drop a slide in flight, from outside.
     *
     * Two callers, both cases where the slide has stopped meaning anything and
     * nothing will tell it so:
     *
     *   a monitor layout change — the cover is pinned to a monitor index and
     *   its pages hold background managers for it, and neither survives a
     *   display arriving or leaving. Worse, once the state is detached
     *   _settle() finds indexOf() === -1 for every revealed window and hides
     *   the lot, tagged, with no group left to restore them from.
     *
     *   the screen locking — the shell's modal grab moves Main.actionMode to
     *   LOCK_SCREEN, and SwipeTracker drops events that do not match its
     *   allowed modes *before* it emits 'end'. The gesture never finishes, so
     *   _session stays set, sliding is dead for the rest of the session, the
     *   cover stays on the stage and disable_unredirect() is never balanced.
     *
     * Must be called while the state still holds its groups — before
     * pruneDetached(), not after.
     */
    cancel() {
        this._cancel();
    }

    /** Drop the cover without committing. Leaves the screen as it was. */
    _cancel() {
        const session = this._session;
        if (!session)
            return;

        this._session = null;
        this._claimed = false;

        this._settle(session, session.state.activeIndex);
        this._teardown(session);
    }

    /**
     * Put back everything that was revealed only to be previewed.
     *
     * switchTo() only touches the workspace being left and the one being
     * entered. With three pages prepared, the one that was neither is still on
     * screen and still tagged hidden — it has to be minimized explicitly, or a
     * swipe leaves a workspace leaking onto the monitor.
     */
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

    /**
     * @returns {boolean} true when this module took the gesture and the
     *   shell's own handler must not run
     */
    _begin(tracker, monitorIndex) {
        this._claimed = false;

        if (!this._settings?.get_boolean('touchpad-gesture'))
            return false;

        // The primary monitor is the shell's. Hand it straight back.
        if (monitorIndex === Main.layoutManager.primaryIndex)
            return false;

        if (this._session) {
            // A swipe landing on a running animation adopts it. Its transition
            // is dropped, which also drops the onComplete that would commit —
            // and it becomes a gesture, so it lands without an OSD.
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

        // Match the axis native workspaces use, so the gesture already in the
        // user's fingers is the one that works here.
        tracker.orientation = global.workspace_manager.layout_rows === -1
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;

        // Mid-animation adoption must resume from where it is, not restart.
        const progress = slide.progress;
        const cancelProgress = slide.progressFor(slide.indexAt(progress));

        tracker.confirmSwipe(
            slide.baseDistance, slide.getSnapPoints(), progress, cancelProgress);

        this._claimed = true;
        return true;
    }

    /** @returns {boolean} true when this gesture is ours */
    _update(progress) {
        const session = this._session;
        if (!session || !this._claimed)
            return false;

        session.slide.progress = progress;

        // The dots read the same fractional number the windows do, and that
        // agreement is most of what makes this feel like the shell's own.
        this._onProgress(session.state, previewIndex(session.slide, progress));
        return true;
    }

    /** @returns {boolean} true when this gesture is ours */
    _end(duration, endProgress) {
        const session = this._session;
        if (!session || !this._claimed)
            return false;

        this._claimed = false;

        const index = session.slide.indexAt(endProgress);

        // duration can be 0, which SwipeTracker documents as "finish instantly".
        session.slide.ease_property('progress', endProgress, {
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => this._finish(index),
        });

        return true;
    }
}

/**
 * Fractional *workspace* index for a page progress value.
 *
 * Interpolating through the page list rather than adding progress to the first
 * index, because pages are not always contiguous or ascending — a wrapping
 * shortcut can leave [3, 0], and a gesture can adopt that animation mid-flight.
 */
function previewIndex(slide, progress) {
    const indices = slide.indices;
    const last = indices.length - 1;

    const clamp = position => Math.min(Math.max(position, 0), last);
    const lower = Math.floor(progress);
    const from = indices[clamp(lower)];
    const to = indices[clamp(Math.ceil(progress))];

    return from + (to - from) * (progress - lower);
}
