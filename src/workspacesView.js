/**
 * The overview, for one secondary monitor, in GNOME's own shape.
 *
 * The primary monitor's overview is a scrolling row of workspaces with the
 * active one centred and its neighbours peeking in at the edges, plus a strip
 * of thumbnails above it. This module gives a secondary monitor the same thing,
 * driven by virtual workspaces instead of native ones.
 *
 * ## Why it is a port and not a reuse
 *
 * `WorkspacesView` and `ThumbnailsBox` are both exported, and neither can be
 * used. They are built from `MetaWorkspace`: `get_workspace_by_index`,
 * `located_on_workspace`, `metaWorkspace.connectObject`. A virtual workspace is
 * a set of windows we agree to show together — it has no MetaWorkspace to hand
 * them. So the layout arithmetic is ported and the machinery around it is not.
 *
 * What is ported, from `WorkspacesView`:
 *
 *   - `_getSpacing`, which derives the gap from how much room is left over
 *     after one monitor-shaped page, clamped to 24..80px. This is why the
 *     neighbours peek by exactly as much as GNOME's do.
 *   - `_getFirstFitSingleWorkspaceBox`, which centres the active page and
 *     shifts the row by `-value * (pageWidth + spacing)`.
 *   - `_updateWorkspacesState`, which scales anything not centred down to 0.94.
 *
 * The fit-mode interpolation is not ported. It exists for the app grid
 * transition, and `_getInitialBoxes` skips it outright for non-primary
 * monitors — so on the monitors this module touches, GNOME is always in
 * FitMode.SINGLE and there is nothing to interpolate.
 *
 * ## The thumbnails could not be copied at all
 *
 * `WorkspaceThumbnail._isOverviewWindow` is:
 *
 *     return !win.get_meta_window().skip_taskbar &&
 *            win.get_meta_window().showing_on_its_workspace();
 *
 * and `showing_on_its_workspace()` is false for a minimized window. GNOME's
 * thumbnails deliberately omit minimized windows — which for us is every window
 * on every inactive virtual workspace. A faithful copy would render four
 * identical empty rectangles.
 *
 * The pages do not have this problem, and the difference is instructive:
 * `WindowPreview` builds on `Shell.WindowPreviewLayout`, a C layout manager
 * that paints the window's texture directly rather than cloning a possibly
 * unmapped actor. The thumbnails here use that same layout, one per window, so
 * a parked workspace shows what is actually parked on it.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Workspace } from 'resource:///org/gnome/shell/ui/workspace.js';
import { ExtraWorkspaceView } from 'resource:///org/gnome/shell/ui/workspacesView.js';
import { lerp } from 'resource:///org/gnome/shell/misc/util.js';

/** Ported from workspacesView.js. */
const WORKSPACE_MIN_SPACING = 24;
const WORKSPACE_MAX_SPACING = 80;
const WORKSPACE_INACTIVE_SCALE = 0.94;
const WORKSPACE_SWITCH_TIME = 250;

/** Share of the monitor height the thumbnail strip may take. */
const THUMBNAILS_HEIGHT_FRACTION = 0.11;

/**
 * Release the native `WindowPreview` a drag came from, the way the shell does.
 *
 * Native `WindowPreview` sets `restoreOnSuccess: true` and we cannot change
 * that. On an accepted drop dnd.js therefore calls `_restoreDragActor()` and
 * returns early, skipping `_dragComplete()` — the only caller of
 * `_ungrabEvents()` — so the pointer stays modally grabbed for the whole
 * REVERT_ANIMATION_TIME (750ms) ease. Native gets away with it because a real
 * workspace drag ends in `change_workspace_by_index()`, whose `window-removed`
 * runs `Workspace._doRemoveWindow()` -> `clone.destroy()`, and destroying the
 * drag actor trips dnd's destroy handler -> `_finishAnimation()` ->
 * `_dragComplete()` in 0ms.
 *
 * Moving a window between *virtual* workspaces fires no Meta signal at all, so
 * that never happens and the full 750ms plays out on every drop.
 *
 * Call the shell's own removal rather than destroying the actor directly:
 * `Workspace._windows` is spliced only by `_removeWindowClone()`, so a bare
 * `destroy()` would leave a disposed `WindowPreview` in that array for
 * `_lookupIndex()` and the `hideOverlay` sweep to walk later.
 *
 * A no-op for our own thumbnails and previews, which carry no `_workspace`
 * and already drag with `restoreOnSuccess: false`.
 */
export function releaseDragPreview(source) {
    const workspace = source?._workspace;
    const window = source?.metaWindow;
    if (!workspace || !window || typeof workspace._doRemoveWindow !== 'function')
        return;

    try {
        workspace._doRemoveWindow(window);
    } catch (e) {
        console.warn(`workspace-islands: releasing drag preview failed: ${e}`);
    }
}

/**
 * The tag for the page currently being constructed.
 *
 * `Workspace._init` ends with
 *
 *     global.get_window_actors().map(a => this._doAddWindow(a.meta_window));
 *
 * so a page filters its entire window list before the constructor returns and
 * there is an object to tag. Tagging afterwards is too late — every page ends
 * up built with no tag, which puts every visible window on every page and every
 * parked one on none.
 *
 * Construction is synchronous and single-threaded, so this handoff is exact
 * rather than merely likely. The alternative would be rebuilding each page's
 * window list after tagging, and Workspace exposes no way to do that.
 */
let building = null;

/** Marks a Workspace as standing for one virtual workspace. */
export const VIRTUAL = Symbol('workspace-islands.virtual');

/** The tag a Workspace should filter by right now, instance or in-flight. */
export function tagFor(workspace) {
    return (workspace && workspace[VIRTUAL]) ? workspace[VIRTUAL] : building;
}

function createPage(monitorIndex, overviewAdjustment, tag) {
    building = tag;
    try {
        const page = new Workspace(null, monitorIndex, overviewAdjustment);
        page.clip_to_allocation = true;
        page[VIRTUAL] = tag;
        if (page.stateAdjustment) {
            const progress = Math.clamp(overviewAdjustment?.value ?? 1, 0, 1);
            page.stateAdjustment.value = progress;
            if (tag?.state && tag.state.activeIndex === tag.index)
                page._container?.layout_manager?.syncOverlays?.();
        }
        return page;
    } finally {
        building = null;
    }
}

/**
 * One thumbnail: wallpaper, plus every window parked on that virtual workspace.
 *
 * Everything is built at monitor scale and the whole container is then scaled
 * down, so window positions need no arithmetic of their own — they are simply
 * where they are on the real screen.
 */
const Thumbnail = GObject.registerClass(
class IslandsThumbnail extends St.Widget {
    _init(monitor, state, index, onDrop, onActivate) {
        super._init({
            style_class: 'workspace-thumbnail',
            reactive: true,
            clip_to_allocation: true,
        });

        this._monitor = monitor;
        this._state = state;
        this._index = index;
        this._onDrop = onDrop;
        this._onActivate = onActivate;

        // DND finds a target through `_delegate`, not through the actor.
        this._delegate = this;

        this._contents = new Clutter.Actor({
            width: monitor.width,
            height: monitor.height,
        });
        this.add_child(this._contents);

        const background = new Meta.BackgroundGroup();
        this._contents.add_child(background);
        this._backgroundManager = new Background.BackgroundManager({
            container: background,
            monitorIndex: monitor.index,
            controlPosition: false,
        });

        this._previews = [];
        this.setWindows(state.windowsOn(index));

        // restoreOnSuccess MUST stay false here. On an accepted drop, dnd.js
        // takes `_restoreDragActor()` when it is true, which eases the drag
        // actor back over REVERT_ANIMATION_TIME (750ms) and only calls
        // `_dragComplete()` — the sole caller of `_ungrabEvents()` — when that
        // ease finishes. The pointer therefore stays modally grabbed for 750ms
        // after every drop. With `false`, dnd destroys it and ungrabs inline.
        this._draggable = DND.makeDraggable(this, {
            restoreOnSuccess: false,
            dragActorMaxSize: 120,
            dragActorOpacity: 200,
        });

        this._draggable.connect('drag-begin', () => {
            const win = this.metaWindow;
            if (win)
                Main.overview.beginWindowDrag(win);
        });
        this._draggable.connect('drag-cancelled', () => {
            const win = this.metaWindow;
            if (win)
                Main.overview.cancelledWindowDrag(win);
        });
        this._draggable.connect('drag-end', () => {
            const win = this.metaWindow;
            if (win)
                Main.overview.endWindowDrag(win);
        });

        this.connect('destroy', () => this._onDestroy());
    }

    get metaWindow() {
        if (this._destroyed)
            return null;
        const windows = this._state.windowsOn(this._index);
        return windows.length > 0 ? windows[windows.length - 1] : null;
    }

    getDragActor() {
        if (this._destroyed)
            return new Clutter.Actor();
        const win = this.metaWindow;
        if (!win)
            return new Clutter.Actor();
        const frame = win.get_frame_rect();
        const dragActor = new Clutter.Actor({
            layout_manager: new Shell.WindowPreviewLayout(),
            width: Math.max(frame.width, 1),
            height: Math.max(frame.height, 1),
        });
        dragActor.layout_manager.add_window(win);
        return dragActor;
    }

    getDragActorSource() {
        return this;
    }

    /**
     * Sync the contents to `windows`, reusing the previews already here.
     *
     * Destroying and re-adding every `Shell.WindowPreviewLayout` on each sync
     * re-acquires a texture per window per thumbnail, which is the bulk of the
     * per-drop cost on a secondary monitor. Only the difference is touched.
     */
    setWindows(windows) {
        if (this._destroyed)
            return;

        if (this._draggable?._dndGesture)
            this._draggable._dndGesture.enabled = windows.length > 0;

        const wanted = new Set(windows);
        for (const preview of [...this._previews]) {
            if (wanted.has(preview.metaWindow))
                wanted.delete(preview.metaWindow);
            else
                preview.destroy();
        }

        for (const window of windows) {
            if (wanted.has(window))
                this._addWindow(window);
        }

        // Stacking follows `windows`, which is the order the state hands them
        // over; a reused preview would otherwise keep whatever depth it had.
        let below = null;
        for (const window of windows) {
            const preview = this._previews.find(p => p.metaWindow === window);
            if (!preview)
                continue;
            this._contents.set_child_above_sibling(preview, below);
            below = preview;
        }
    }

    /**
     * The strip is the only drop target that is actually reachable.
     *
     * In the scrolling model one page fills the monitor and the others are off
     * screen, so dragging a window onto a *page* other than the one you started
     * from is not a gesture anyone can perform. The thumbnails are.
     */
    handleDragOver(source) {
        if (this._destroyed || !source?.metaWindow)
            return DND.DragMotionResult.CONTINUE;

        return this._state.indexOf(source.metaWindow) === this._index
            ? DND.DragMotionResult.CONTINUE
            : DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        if (this._destroyed || !source?.metaWindow)
            return false;

        const win = source.metaWindow;
        if (this._state.indexOf(win) === this._index)
            return false;

        // Before the move: onDrop() can schedule a rebuild of the very page
        // this preview belongs to.
        releaseDragPreview(source);

        this._onDrop(this._index, win, this._monitor.index);
        return true;
    }

    /**
     * Shell.WindowPreviewLayout, not Clutter.Clone.
     *
     * A clone of a minimized window's actor paints nothing, and on an inactive
     * virtual workspace every window is minimized. This is the same C layout
     * `WindowPreview` uses, and it paints the window's texture regardless.
     */
    _addWindow(window) {
        const frame = window.get_frame_rect();
        if (frame.width <= 0 || frame.height <= 0)
            return;

        const preview = new Clutter.Actor({
            layout_manager: new Shell.WindowPreviewLayout(),
            x: frame.x - this._monitor.x,
            y: frame.y - this._monitor.y,
            width: frame.width,
            height: frame.height,
            reactive: true,
        });

        const clone = preview.layout_manager.add_window(window);
        if (!clone) {
            preview.destroy();
            return;
        }

        Shell.util_set_hidden_from_pick(clone, true);

        preview._delegate = preview;
        preview.metaWindow = window;

        const draggable = DND.makeDraggable(preview, {
            restoreOnSuccess: false,
            dragActorMaxSize: 120,
            dragActorOpacity: 200,
        });

        draggable.connect('drag-begin', () => {
            Main.overview.beginWindowDrag(window);
        });
        draggable.connect('drag-cancelled', () => {
            Main.overview.cancelledWindowDrag(window);
        });
        draggable.connect('drag-end', () => {
            Main.overview.endWindowDrag(window);
        });

        this._contents.add_child(preview);
        this._previews.push(preview);

        preview.connect('destroy', () => {
            const at = this._previews.indexOf(preview);
            if (at !== -1)
                this._previews.splice(at, 1);
        });
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const [width, height] = box.get_size();
        if (width <= 0 || height <= 0 || this._monitor.width <= 0 || this._monitor.height <= 0)
            return;
        this._contents.set_scale(
            width / this._monitor.width, height / this._monitor.height);
        this._contents.allocate_preferred_size(0, 0);
    }

    _onDestroy() {
        this._destroyed = true;
        this._backgroundManager?.destroy();
        this._backgroundManager = null;
    }
});

/**
 * The strip. A row of monitor-shaped thumbnails with an accent frame on the
 * active one, using the shell's own style classes so it matches whatever theme
 * is loaded.
 */
const Thumbnails = GObject.registerClass(
class IslandsThumbnails extends St.Widget {
    _init(monitor, state, onActivate, onDrop) {
        super._init({ style_class: 'workspace-thumbnails' });

        this._monitor = monitor;
        this._state = state;
        this._onActivate = onActivate;
        this._onDrop = onDrop;

        this._thumbnails = [];
        this._buildThumbnails();

        // A separate actor rather than a border on the active thumbnail: it is
        // how the shell draws it, and it can be moved without a restyle.
        this._indicator = new St.Widget({
            style_class: 'workspace-thumbnail-indicator',
        });
        Shell.util_set_hidden_from_pick(this._indicator, true);
        this.add_child(this._indicator);

        this.setActive(state.activeIndex);
    }

    /**
     * Update window clones in place without destroying thumbnail actors.
     * Prevents gesture drops or DND aborts during overview interactions.
     */
    syncWindows() {
        if (this._thumbnails.length !== this._state.size) {
            this.rebuild();
            return;
        }
        for (let i = 0; i < this._thumbnails.length; i++)
            this._thumbnails[i].setWindows(this._state.windowsOn(i));
        this.setActive(this._state.activeIndex);
    }

    /**
     * Below `this._indicator` when it already exists, so a rebuild does not
     * repaint the fresh thumbnails on top of it — the indicator is a border
     * overlay and has to stay the topmost child. Not yet built the first
     * time this runs, from the constructor, so a plain append is right there.
     */
    _buildThumbnails() {
        for (let index = 0; index < this._state.size; index++) {
            const thumbnail = new Thumbnail(this._monitor, this._state, index, this._onDrop, this._onActivate);

            const click = new Clutter.ClickGesture();
            click.connect('recognize', () => this._onActivate(index));
            thumbnail.add_action(click);

            if (this._indicator)
                this.insert_child_below(thumbnail, this._indicator);
            else
                this.add_child(thumbnail);
            this._thumbnails.push(thumbnail);
        }
    }

    /**
     * Destroy and recreate every thumbnail from the current `state.size`.
     *
     * Mirrors the constructor's own loop; a straightforward destroy-and-
     * recreate is enough because a workspace count change is an infrequent,
     * human-scale event, not a per-frame one.
     */
    rebuild() {
        for (const thumbnail of this._thumbnails)
            thumbnail.destroy();

        this._thumbnails = [];
        this._buildThumbnails();

        this.setActive(this._state.activeIndex);
    }

    setActive(index) {
        this._active = Math.min(Math.max(Math.round(index), 0),
            this._thumbnails.length - 1);
        this.queue_relayout();
    }

    /** Height the strip wants for a given thumbnail height. */
    heightFor(thumbnailHeight) {
        const themeNode = this.get_theme_node();
        return thumbnailHeight + themeNode.get_vertical_padding();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const themeNode = this.get_theme_node();
        const contentBox = themeNode.get_content_box(box);
        const [width, height] = contentBox.get_size();

        const count = this._thumbnails.length;
        const spacing = themeNode.get_length('spacing');

        const aspect = this._monitor.width / this._monitor.height;

        // Fit by height, then shrink if the row would overflow.
        let thumbHeight = height;
        let thumbWidth = thumbHeight * aspect;
        const rowWidth = thumbWidth * count + spacing * (count - 1);
        if (rowWidth > width) {
            thumbWidth = (width - spacing * (count - 1)) / count;
            thumbHeight = thumbWidth / aspect;
        }

        let x = contentBox.x1 +
            Math.round((width - (thumbWidth * count + spacing * (count - 1))) / 2);
        const y = contentBox.y1 + Math.round((height - thumbHeight) / 2);

        for (const thumbnail of this._thumbnails) {
            const childBox = new Clutter.ActorBox();
            childBox.set_origin(Math.round(x), y);
            childBox.set_size(Math.round(thumbWidth), Math.round(thumbHeight));
            thumbnail.allocate(childBox);

            x += thumbWidth + spacing;
        }

        const active = this._thumbnails[this._active];
        if (active)
            this._indicator.allocate(active.allocation);
    }
});

export const VirtualWorkspacesView = GObject.registerClass(
class IslandsWorkspacesView extends ExtraWorkspaceView {
    /**
     * @param {number} monitorIndex
     * @param {St.Adjustment} overviewAdjustment
     * @param {object} state MonitorState
     * @param {(index: number) => void} onActivate commit a switch
     * @param {(index: number, window: Meta.Window, monitorIndex: number) => void} onDrop
     */
    _init(monitorIndex, overviewAdjustment, state, onActivate, onDrop) {
        // Page 0 is built inside super._init(), so its tag has to be in place
        // before that call — not after, when its window list already exists.
        const first = { state, index: 0, onDrop: (...args) => this._drop(...args) };
        building = first;
        try {
            super._init(monitorIndex, overviewAdjustment);
        } finally {
            building = null;
        }

        this._state = state;
        this._onActivate = onActivate;
        this._onDrop = onDrop;
        this._monitorIndex = monitorIndex;
        this._monitor = Main.layoutManager.monitors[monitorIndex];
        this._refreshId = 0;
        this._dragEndId = 0;

        this._workspace[VIRTUAL] = first;
        this._pages = [this._workspace];

        for (let index = 1; index < state.size; index++) {
            const page = createPage(monitorIndex, overviewAdjustment, {
                state,
                index,
                onDrop: (...args) => this._drop(...args),
            });

            this.add_child(page);
            this._pages.push(page);
        }

        // Fractional, exactly like the shell's: whole numbers only ever appear
        // at rest, and everything in between is a gesture in progress.
        this._scrollAdjustment = new St.Adjustment({
            actor: this,
            lower: 0,
            upper: state.size,
            value: state.activeIndex,
            page_size: 1,
            step_increment: 1,
        });

        this._scrollAdjustment.connect('notify::value', () => {
            this._updateWorkspacesState();
            this._thumbnails?.setActive(this._scrollAdjustment.value);
            this.queue_relayout();
        });

        this._thumbnails = new Thumbnails(this._monitor, state,
            index => this.activate(index),
            (...args) => this._drop(...args));
        this.add_child(this._thumbnails);

        // Growth/shrink can happen at any time in dynamic mode, not just after
        // a drop — a page or thumbnail appearing/disappearing needs the same
        // rebuild, just triggered reactively instead of from _drop().
        this._unsubscribeSize = state.onSizeChanged(() => this._scheduleRefresh());

        this.connect('destroy', () => {
            if (this._refreshId) {
                GLib.Source.remove(this._refreshId);
                this._refreshId = 0;
            }
            if (this._dragEndId) {
                Main.overview.disconnect(this._dragEndId);
                this._dragEndId = 0;
            }
            this._unsubscribeSize?.();
        });

        this._updateWorkspacesState();
    }

    /**
     * Apply a drop, then rebuild.
     *
     * Moving a window between virtual workspaces fires no Meta signal — it is
     * a minimize, and Workspace only listens for workspace and monitor changes
     * — so nothing here would notice on its own. The rebuild is deferred to an
     * idle because this runs from inside DND's accept callback, which is no
     * place to destroy the actor tree the drag just landed on.
     */
    _drop(index, window, monitorIndex) {
        this._onDrop(index, window, monitorIndex);
        this._scheduleRefresh();
    }

    /**
     * Coalesce any number of drops/size-changes within one main loop turn into
     * a single rebuild that reads the final state — a burst of growth/shrink
     * from rapid open/close only costs one rebuild, not one per event.
     */
    _scheduleRefresh() {
        if (this._refreshId)
            return;

        // If a window is currently being dragged, defer refresh until DND completes
        if (Main.overview._inWindowDrag) {
            if (this._dragEndId)
                return;

            this._dragEndId = Main.overview.connect('window-drag-end', () => {
                if (this._dragEndId) {
                    Main.overview.disconnect(this._dragEndId);
                    this._dragEndId = 0;
                }
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this._scheduleRefresh();
                    return GLib.SOURCE_REMOVE;
                });
            });
            return;
        }

        this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshId = 0;
            if (Main.overview._inWindowDrag) {
                this._scheduleRefresh();
                return GLib.SOURCE_REMOVE;
            }
            if (this._pages.length !== this._state.size) {
                this._rebuildPages();
                this._thumbnails.rebuild();
            } else {
                this._thumbnails.syncWindows();
                this._updateWorkspacesState();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuildPages() {
        for (const page of this._pages)
            page.destroy();

        this._pages = [];

        for (let index = 0; index < this._state.size; index++) {
            const page = createPage(this._monitorIndex, this._overviewAdjustment, {
                state: this._state,
                index,
                onDrop: (...args) => this._drop(...args),
            });

            this.insert_child_below(page, this._thumbnails);
            this._pages.push(page);
        }

        if (this._thumbnails)
            this.set_child_above_sibling(this._thumbnails, null);

        // The first page stands in for `this._workspace`, which the parent
        // class still reaches for in _updateWorkspaceMode.
        this._workspace = this._pages[0];

        // Only ever read at construction until now, because a drop never
        // changed page count. Structural size changes do, so the scroll
        // range has to move in lock-step with the rebuilt page list — and
        // `value` has to move with it: a collapse can shift `activeIndex`
        // out from under a `value` that's still in range, which leaves the
        // pages showing one workspace while the thumbnail strip highlights
        // another.
        this._scrollAdjustment.upper = this._state.size;
        this._scrollAdjustment.value = Math.clamp(this._scrollAdjustment.value, 0, this._state.size - 1);

        this._updateWorkspacesState();
        this._updateWorkspaceMode();
        this.queue_relayout();
    }

    /** @returns {St.Adjustment} what a swipe writes into */
    get scrollAdjustment() {
        return this._scrollAdjustment;
    }

    get pageCount() {
        return this._pages.length;
    }

    /** Animate to a workspace and commit it. */
    activate(index) {
        if (index === this._state.activeIndex) {
            this._scrollAdjustment.ease(index, {
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                duration: WORKSPACE_SWITCH_TIME,
            });
            return;
        }

        this._scrollAdjustment.ease(index, {
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            duration: WORKSPACE_SWITCH_TIME,
            onComplete: () => this._onActivate(index),
        });
    }

    /** Ported from WorkspacesView._getSpacing, minus the fit-mode term. */
    _getSpacing(box) {
        const [width, height] = box.get_size();
        const [page] = this._pages;

        const [, pageWidth] = page.get_preferred_width(height);
        const availableSpace = (width - pageWidth) / 2;

        const spacing = availableSpace - pageWidth * 0.4;
        const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);

        return Math.min(
            Math.max(spacing, WORKSPACE_MIN_SPACING * scaleFactor),
            WORKSPACE_MAX_SPACING * scaleFactor);
    }

    /** Ported from WorkspacesView._updateWorkspacesState. */
    _updateWorkspacesState() {
        const value = this._scrollAdjustment?.value ?? 0;
        const progress = Math.clamp(this._overviewAdjustment?.value ?? 1, 0, 1);
        const currentIndex = Math.round(value);

        for (const [index, page] of (this._pages ?? []).entries()) {
            const distance = Math.abs(value - index);
            const scaleProgress = 1 - Math.min(Math.max(distance, 0), 1);

            // Hide distant workspaces to prevent offscreen window previews from bleeding
            page.visible = Math.abs(index - currentIndex) <= 1;

            if (page.stateAdjustment) {
                page.stateAdjustment.value = progress;
                if (distance < 0.5 && progress > 0.9)
                    page._container?.layout_manager?.syncOverlays?.();
            }

            const scale = lerp(WORKSPACE_INACTIVE_SCALE, 1, scaleProgress);
            page.set_scale(scale, scale);
        }
    }

    _updateWorkspaceMode() {
        super._updateWorkspaceMode();

        const progress = Math.clamp(this._overviewAdjustment?.value ?? 1, 0, 1);
        const value = this._scrollAdjustment?.value ?? 0;

        for (const [index, page] of (this._pages ?? []).entries()) {
            if (page.stateAdjustment) {
                const distance = Math.abs(value - index);
                page.stateAdjustment.value = progress;
                if (distance < 0.5 && progress > 0.9)
                    page._container?.layout_manager?.syncOverlays?.();
            }
        }
    }

    vfunc_allocate(box) {
        if (!this._pages) {
            super.vfunc_allocate(box);
            return;
        }

        this.set_allocation(box);

        const [width, height] = box.get_size();

        // Strip on top, pages in what is left. Keeping the strip inside this
        // view rather than beside it is what lets SecondaryMonitorDisplay's own
        // allocate stay untouched.
        const stripHeight = Math.round(
            this._thumbnails.heightFor(Math.round(height * THUMBNAILS_HEIGHT_FRACTION)));

        const stripBox = new Clutter.ActorBox();
        stripBox.set_origin(0, 0);
        stripBox.set_size(width, stripHeight);
        this._thumbnails.allocate(stripBox);

        const pagesBox = new Clutter.ActorBox();
        pagesBox.set_origin(0, stripHeight);
        pagesBox.set_size(width, height - stripHeight);

        const spacing = this._getSpacing(pagesBox);
        const [pagesWidth, pagesHeight] = pagesBox.get_size();
        const [, pageWidth] = this._pages[0].get_preferred_width(pagesHeight);

        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        const value = rtl
            ? this._scrollAdjustment.upper - this._scrollAdjustment.value - 1
            : this._scrollAdjustment.value;

        // Ported from _getFirstFitSingleWorkspaceBox: centre the active page,
        // then slide the whole row by however far along it we are.
        let x = pagesBox.x1 + (pagesWidth - pageWidth) / 2 -
            value * (pageWidth + spacing);

        for (const page of this._pages) {
            const childBox = new Clutter.ActorBox();
            childBox.set_origin(Math.round(x), pagesBox.y1);
            childBox.set_size(Math.round(pageWidth), pagesHeight);
            page.allocate_align_fill(childBox, 0.5, 0.5, false, false);

            x += pageWidth + spacing;
        }
    }

    getActiveWorkspace() {
        return this._pages?.[this._state.activeIndex] ?? this._workspace;
    }

    prepareToLeaveOverview() {
        for (const page of this._pages ?? [])
            page.prepareToLeaveOverview();
    }

    syncStacking(stackIndices) {
        for (const page of this._pages ?? [])
            page.syncStacking(stackIndices);
    }

    startTouchGesture() {
    }

    endTouchGesture() {
    }
});
