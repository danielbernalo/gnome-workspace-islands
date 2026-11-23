// Ports GNOME's overview layout: WorkspacesView and ThumbnailsBox need a real MetaWorkspace.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Workspace } from 'resource:///org/gnome/shell/ui/workspace.js';
import { ExtraWorkspaceView } from 'resource:///org/gnome/shell/ui/workspacesView.js';
import { lerp } from 'resource:///org/gnome/shell/misc/util.js';

const WORKSPACE_MIN_SPACING = 24;
const WORKSPACE_MAX_SPACING = 80;
const WORKSPACE_INACTIVE_SCALE = 0.94;
const WORKSPACE_SWITCH_TIME = 250;

const THUMBNAILS_HEIGHT_FRACTION = 0.11;

// The theme's 4px radius reads as square at thumbnail size; 8px matches the active frame.
const THUMBNAIL_MIN_CORNER_RADIUS = 8;

// Workspace._init filters its windows before returning, so a page's tag must be set first.
let building = null;

export const VIRTUAL = Symbol('workspace-islands.virtual');

export function tagFor(workspace) {
    return workspace[VIRTUAL] ?? building;
}

function createPage(monitorIndex, overviewAdjustment, tag) {
    building = tag;
    try {
        const page = new Workspace(null, monitorIndex, overviewAdjustment);
        page[VIRTUAL] = tag;
        return page;
    } finally {
        building = null;
    }
}

const Thumbnail = GObject.registerClass(
class IslandsThumbnail extends St.Widget {
    _init(monitor, state, index, onDrop) {
        super._init({
            style_class: 'workspace-thumbnail',
            reactive: true,
            clip_to_allocation: true,
        });

        // Transparent so the rounded wallpaper does not uncover the theme's grey thumbnail body.
        this.set_style('background-color: transparent;');

        this._monitor = monitor;
        this._state = state;
        this._index = index;
        this._onDrop = onDrop;

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

        // A wallpaper change swaps the background actor, so its rounded clip must be re-applied.
        this._backgroundManager.connect('changed', () => this._roundBackground());

        this._previews = [];
        this.setWindows(state.windowsOn(index));

        this.connect('destroy', () => this._onDestroy());
    }

    setWindows(windows) {
        for (const preview of this._previews)
            preview.destroy();

        this._previews = [];

        for (const window of windows)
            this._addWindow(window);
    }

    handleDragOver(source) {
        if (!source?.metaWindow)
            return DND.DragMotionResult.CONTINUE;

        return this._state.indexOf(source.metaWindow) === this._index
            ? DND.DragMotionResult.CONTINUE
            : DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        if (!source?.metaWindow)
            return false;

        if (this._state.indexOf(source.metaWindow) === this._index)
            return false;

        this._onDrop(this._index, source.metaWindow, this._monitor.index);
        return true;
    }

    // WindowPreviewLayout, not Clutter.Clone: a clone of a minimized window paints nothing.
    _addWindow(window) {
        const frame = window.get_frame_rect();

        const preview = new Clutter.Actor({
            layout_manager: new Shell.WindowPreviewLayout(),
            x: frame.x - this._monitor.x,
            y: frame.y - this._monitor.y,
            width: frame.width,
            height: frame.height,
        });

        if (!preview.layout_manager.add_window(window)) {
            preview.destroy();
            return;
        }

        this._contents.add_child(preview);
        this._previews.push(preview);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const [width, height] = box.get_size();
        this._contents.set_scale(
            width / this._monitor.width, height / this._monitor.height);
        this._contents.allocate_preferred_size(0, 0);

        this._paintedWidth = width;
        this._roundBackground();
    }

    // Cut on the background content, whose space is the monitor, so the radius is scaled up.
    _roundBackground() {
        const content = this._backgroundManager?.backgroundActor?.content;
        if (!content || !this._paintedWidth)
            return;

        if (this._roundedContent === content &&
            this._roundedWidth === this._paintedWidth) {
            return;
        }

        const radius = Math.max(
            this.get_theme_node().get_border_radius(St.Corner.TOPLEFT),
            THUMBNAIL_MIN_CORNER_RADIUS) * this._monitor.width / this._paintedWidth;

        if (!this._clipBounds) {
            this._clipBounds = new Graphene.Rect();
            this._clipBounds.origin.x = 0;
            this._clipBounds.origin.y = 0;
            this._clipBounds.size.width = this._monitor.width;
            this._clipBounds.size.height = this._monitor.height;
        }

        this._roundedContent = content;
        this._roundedWidth = this._paintedWidth;

        content.rounded_clip_radius = radius;
        content.set_rounded_clip_bounds(this._clipBounds);
    }

    _onDestroy() {
        this._backgroundManager?.destroy();
        this._backgroundManager = null;
    }
});

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

        this._indicator = new St.Widget({
            style_class: 'workspace-thumbnail-indicator',
        });

        // Hidden from pick: DND picks non-reactive actors too, so drops would land on this frame.
        Shell.util_set_hidden_from_pick(this._indicator, true);
        this.add_child(this._indicator);

        this.setActive(state.activeIndex);
    }

    // Below the indicator so it stays topmost; it does not exist yet on the first build.
    _buildThumbnails() {
        for (let index = 0; index < this._state.size; index++) {
            const thumbnail = new Thumbnail(this._monitor, this._state, index, this._onDrop);

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
    _init(monitorIndex, overviewAdjustment, state, onActivate, onDrop) {
        // Page 0 is built inside super._init(), so its tag must be in place before that call.
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
        this._pendingIndex = null;

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

        this._unsubscribeSize = state.onSizeChanged(() => this._scheduleRefresh());

        this.connect('destroy', () => {
            if (this._refreshId) {
                GLib.Source.remove(this._refreshId);
                this._refreshId = 0;
            }
            this._unsubscribeSize?.();
        });

        this._updateWorkspacesState();
        this._updateWorkspaceMode();
    }

    // Moves fire no Meta signal, and the rebuild must wait until DND's accept callback returns.
    _drop(index, window, monitorIndex) {
        this._onDrop(index, window, monitorIndex);
        this._scheduleRefresh();
    }

    _scheduleRefresh() {
        if (this._refreshId)
            return;

        this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshId = 0;
            this._rebuildPages();
            this._thumbnails.rebuild();
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

        // The parent class still reads `this._workspace` in _updateWorkspaceMode.
        this._workspace = this._pages[0];

        // A collapse can shift activeIndex, so range and value must follow the rebuilt pages.
        this._scrollAdjustment.upper = this._state.size;
        this._scrollAdjustment.value = this._state.activeIndex;

        this._updateWorkspacesState();
        this.queue_relayout();
    }

    get scrollAdjustment() {
        return this._scrollAdjustment;
    }

    get pageCount() {
        return this._pages.length;
    }

    // Remembered because closing the overview ends the ease without calling onComplete.
    activate(index, duration = WORKSPACE_SWITCH_TIME) {
        this._pendingIndex = index;

        this._scrollAdjustment.ease(index, {
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            duration,
            onComplete: () => this._commitPending(),
        });
    }

    cancelSwitch() {
        this._pendingIndex = null;
        this._scrollAdjustment.remove_transition('value');
    }

    _commitPending() {
        const index = this._pendingIndex;
        this._pendingIndex = null;

        if (Number.isInteger(index) && index !== this._state.activeIndex)
            this._onActivate(index);
    }

    // Ported from WorkspacesView._getSpacing, minus the fit-mode term.
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

    _updateWorkspacesState() {
        const value = this._scrollAdjustment?.value ?? 0;

        for (const [index, page] of (this._pages ?? []).entries()) {
            const distance = Math.abs(value - index);
            const scale = lerp(WORKSPACE_INACTIVE_SCALE, 1,
                1 - Math.min(Math.max(distance, 0), 1));

            page.set_scale(scale, scale);
        }
    }

    _updateWorkspaceMode() {
        super._updateWorkspaceMode();

        const { value } = this._workspace.stateAdjustment;
        for (const page of this._pages ?? [])
            page.stateAdjustment.value = value;

        if (this._thumbnails)
            this._thumbnails.opacity = Math.round(255 * value);
    }

    vfunc_allocate(box) {
        if (!this._pages) {
            super.vfunc_allocate(box);
            return;
        }

        this.set_allocation(box);

        const [width, height] = box.get_size();

        const stripHeight = Math.round(
            this._thumbnails.heightFor(Math.round(height * THUMBNAILS_HEIGHT_FRACTION)));

        const stripBox = new Clutter.ActorBox();
        stripBox.set_origin(0, 0);
        stripBox.set_size(width, stripHeight);
        this._thumbnails.allocate(stripBox);

        // Reserve the strip only as the overview opens, so hidden-state previews match real windows.
        const openness = Math.min(Math.max(this._overviewAdjustment.value, 0), 1);
        const reserved = Math.round(stripHeight * openness);

        const pagesBox = new Clutter.ActorBox();
        pagesBox.set_origin(0, reserved);
        pagesBox.set_size(width, height - reserved);

        const spacing = this._getSpacing(pagesBox);
        const [pagesWidth, pagesHeight] = pagesBox.get_size();
        const [, pageWidth] = this._pages[0].get_preferred_width(pagesHeight);

        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        const value = rtl
            ? this._scrollAdjustment.upper - this._scrollAdjustment.value - 1
            : this._scrollAdjustment.value;

        let x = pagesBox.x1 + (pagesWidth - pageWidth) / 2 -
            value * (pageWidth + spacing);

        // The shell also reverses the page order for RTL, as the other half of the value mapping.
        const pages = rtl ? [...this._pages].reverse() : this._pages;

        for (const page of pages) {
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

    // Commit a switch still animating: the overview showed its page, so the desktop returns to it.
    prepareToLeaveOverview() {
        if (Number.isInteger(this._pendingIndex)) {
            this._scrollAdjustment.remove_transition('value');
            this._scrollAdjustment.value = this._pendingIndex;
            this._commitPending();
        }

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
