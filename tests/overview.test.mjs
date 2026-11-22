/**
 * The overview seams, driven through the real overrides and the real view.
 *
 * The default stubs swallow everything a shell module is asked for, including
 * the InjectionManager and GObject.registerClass, so neither the overrides nor
 * the view's methods would ever run. These tests swap in just enough of the
 * shell for overview.js to patch real prototypes and for VirtualWorkspacesView
 * to be a plain class whose methods can be called on a hand-built instance.
 *
 * Each fake mirrors the shell 51 behaviour the code depends on, and says so
 * where that behaviour is the point of the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const fakes = {};
globalThis.__wiFakes = fakes;


/** An actor with just connectObject/disconnectObject, keyed by owner. */
class FakeActor {
    constructor() {
        this.handlers = [];
    }

    connectObject(signal, handler, owner) {
        this.handlers.push({ signal, handler, owner });
    }

    disconnectObject(owner) {
        this.handlers = this.handlers.filter(h => h.owner !== owner);
    }
}

class ActorBox {
    constructor() {
        this.x1 = this.y1 = this.x2 = this.y2 = 0;
    }

    set_origin(x, y) {
        const [width, height] = this.get_size();
        this.x1 = x;
        this.y1 = y;
        this.x2 = x + width;
        this.y2 = y + height;
    }

    set_size(width, height) {
        this.x2 = this.x1 + width;
        this.y2 = this.y1 + height;
    }

    get_size() {
        return [this.x2 - this.x1, this.y2 - this.y1];
    }
}

const Clutter = {
    ActorBox,
    AnimationMode: { EASE_OUT_CUBIC: 0 },
    Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
    TextDirection: { NONE: 0, LTR: 1, RTL: 2 },
    ScrollDirection: { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, SMOOTH: 4 },
    EVENT_PROPAGATE: false,
    EVENT_STOP: true,
};

class InjectionManager {
    constructor() {
        this._saved = [];
    }

    overrideMethod(proto, name, factory) {
        const original = proto[name];
        this._saved.push([proto, name, original]);
        proto[name] = factory(original);
    }

    clear() {
        for (const [proto, name, original] of this._saved.reverse())
            proto[name] = original;
        this._saved = [];
    }
}

/**
 * TouchpadSwipeGesture as shell 51 has it: connected to the actor it was given,
 * disconnected from the *stage* on destroy. The asymmetry is the bug under
 * test, so it is reproduced exactly.
 */
class FakeTouchpadGesture {
    constructor(actor) {
        actor.connectObject('event::touchpad', () => {}, this);
    }

    destroy() {
        globalThis.global.stage.disconnectObject(this);
    }
}

class FakeSwipeTracker {
    constructor(actor) {
        this.enabled = true;
        this.orientation = Clutter.Orientation.HORIZONTAL;
        this._handlers = {};
        this._touchpadGesture = new FakeTouchpadGesture(actor);
    }

    connect(name, handler) {
        this._handlers[name] = handler;
    }

    emit(name, ...args) {
        this._handlers[name]?.(this, ...args);
    }

    confirmSwipe(distance, points, progress, cancelProgress) {
        this.confirmed = { distance, points, progress, cancelProgress };
    }

    destroy() {
        this._touchpadGesture?.destroy();
        delete this._touchpadGesture;
        this.destroyed = true;
    }
}

/** The shell 51 click paths, with the original's answer marked. */
class Workspace {
    _shouldLeaveOverview() {
        return 'original';
    }

    // As the shell has it: a window click asks _shouldLeaveOverview too.
    _onCloneSelected(clone, time) {
        this.originalSelected = true;
        if (this._shouldLeaveOverview())
            Main.activateWindow(clone.metaWindow, time, this.metaWorkspace?.index());
        else
            this.metaWorkspace?.activate(time);
    }

    _isOverviewWindow() {
        return true;
    }

    handleDragOver() {}

    acceptDrop() {}
}

const activated = [];
const overviewGroup = new FakeActor();
const display = {};

const Main = {
    activateWindow: (window, time, workspaceNum) =>
        activated.push([window, time, workspaceNum]),
    layoutManager: { overviewGroup, primaryIndex: 0, monitors: [] },
    overview: { _overview: { controls: { _workspacesDisplay: display } } },
};

globalThis.global = {
    stage: new FakeActor(),
    workspace_manager: { layout_rows: 1 },
};

fakes['gi://Clutter'] = { default: Clutter };
fakes['gi://GObject'] = { default: { registerClass: klass => klass } };
fakes['gi://Shell'] = {
    default: { ActionMode: { OVERVIEW: 1 }, util_set_hidden_from_pick() {} },
};
fakes['gi://St'] = {
    default: {
        Widget: class {},
        ThemeContext: { get_for_stage: () => ({ scaleFactor: 1 }) },
    },
};
fakes['resource:///org/gnome/shell/extensions/extension.js'] = { InjectionManager };
fakes['resource:///org/gnome/shell/ui/main.js'] = Main;
fakes['resource:///org/gnome/shell/ui/swipeTracker.js'] = { SwipeTracker: FakeSwipeTracker };
fakes['resource:///org/gnome/shell/ui/overviewControls.js'] = {
    ControlsState: { HIDDEN: 0, WINDOW_PICKER: 1, APP_GRID: 2 },
};
fakes['resource:///org/gnome/shell/ui/workspace.js'] = {
    Workspace,
    WorkspaceBackground: class { _updateRoundedClipBounds() {} },
};
fakes['resource:///org/gnome/shell/ui/workspacesView.js'] = {
    ExtraWorkspaceView: class {},
    SecondaryMonitorDisplay: class { _updateWorkspacesView() {} },
    WorkspacesDisplay: class { _onScrollEvent() {} },
};
fakes['resource:///org/gnome/shell/misc/util.js'] = {
    lerp: (start, end, progress) => start + progress * (end - start),
};


const Overview = await import('../src/overview.js');
const { VirtualWorkspacesView, VIRTUAL } = await import('../src/workspacesView.js');

/**
 * An St.Adjustment's `value` with one ease in flight at a time, completed the
 * way shell 51's _makeEaseCallback does: onComplete only when it finished,
 * never when it was removed or its actor destroyed.
 */
class FakeAdjustment {
    constructor(value, upper) {
        this.value = value;
        this.upper = upper;
        this.transition = null;
    }

    ease(target, params) {
        this.remove_transition('value');
        this.transition = { target, params };
    }

    remove_transition() {
        const transition = this.transition;
        this.transition = null;
        transition?.params.onStopped?.(false);
    }

    finish() {
        const { target, params } = this.transition;
        this.transition = null;
        this.value = target;
        params.onStopped?.(true);
        params.onComplete?.();
    }
}

function fakePage() {
    return {
        left: 0,
        prepareToLeaveOverview() {
            this.left++;
        },
        set_scale() {},
        get_preferred_width: () => [0, 1000],
        allocate_align_fill(box) {
            this.box = box;
        },
    };
}

/** A view without its constructor: the state and fields its methods read. */
function fakeView({ size = 3, activeIndex = 0 } = {}) {
    const state = { size, activeIndex };
    const commits = [];

    const view = Object.create(VirtualWorkspacesView.prototype);
    Object.assign(view, {
        _state: state,
        _onActivate: index => {
            commits.push(index);
            state.activeIndex = index;
        },
        _pages: Array.from({ length: size }, fakePage),
        _scrollAdjustment: new FakeAdjustment(activeIndex, size),
        _overviewAdjustment: { value: 1 },
        _thumbnails: { heightFor: h => h, allocate() {}, setActive() {} },
        text_direction: Clutter.TextDirection.LTR,
        set_allocation() {},
        width: 1920,
        height: 1080,
    });

    return { view, state, commits };
}

/** Patch with one managed secondary monitor (index 1) showing `view`. */
function setUp(view, state) {
    const shellTracker = { enabled: true };
    Object.assign(display, {
        _swipeTracker: shellTracker,
        // unpatch() asks each display holding one of ours to rebuild.
        _workspacesViews: [null, {
            _workspacesView: view,
            _updateWorkspacesView() {
                this.rebuilt = true;
            },
        }],
    });

    Overview.patch({
        getState: index => (index === 1 ? state : null),
        onActivate: () => {},
        onDrop: () => {},
        log: () => {},
    });

    return { tracker: display._swipeTracker, shellTracker };
}

function tearDown() {
    Overview.unpatch();
    activated.length = 0;
}

function swipe(tracker, to, duration = 300) {
    tracker.emit('begin', 1);
    tracker.emit('update', to);
    tracker.emit('end', duration, to);
}

// --- Finding: the swipe tracker's touchpad handler outlives disable() -------

test('unpatch() leaves no touchpad handler on overviewGroup', () => {
    const { view, state } = fakeView();
    const { tracker, shellTracker } = setUp(view, state);

    assert.equal(shellTracker.enabled, false, 'the shell tracker is parked');
    assert.equal(overviewGroup.handlers.length, 1);

    tearDown();

    assert.deepEqual(overviewGroup.handlers, []);
    assert.equal(tracker.destroyed, true);
    assert.equal(tracker.enabled, false);
    assert.equal(display._swipeTracker, shellTracker, 'the shell tracker is back');
    assert.equal(shellTracker.enabled, true);
});

// --- Finding: a swipe is discarded if the overview closes mid-snap ----------

test('a finished swipe commits when its snap lands, in one animation', () => {
    const { view, state, commits } = fakeView();
    const { tracker } = setUp(view, state);
    try {
        swipe(tracker, 1, 300);

        assert.equal(view.scrollAdjustment.transition.target, 1);
        assert.equal(view.scrollAdjustment.transition.params.duration, 300,
            'the snap runs at the tracker\'s own duration');

        view.scrollAdjustment.finish();

        assert.deepEqual(commits, [1]);
        assert.equal(view.scrollAdjustment.transition, null, 'no second ease');
        assert.equal(view.scrollAdjustment.value, 1);
    } finally {
        tearDown();
    }
});

test('closing the overview during the snap still commits the swipe', () => {
    const { view, state, commits } = fakeView();
    const { tracker } = setUp(view, state);
    try {
        swipe(tracker, 1);

        view.prepareToLeaveOverview();

        assert.deepEqual(commits, [1]);
        assert.equal(state.activeIndex, 1);
        assert.equal(view.scrollAdjustment.value, 1, 'the page it committed is centred');
        assert.equal(view.scrollAdjustment.transition, null);
        assert.ok(view._pages.every(page => page.left === 1),
            'every page is still told the overview is leaving');

        // The view is destroyed by the end of the close; nothing commits twice.
        view.prepareToLeaveOverview();
        assert.deepEqual(commits, [1]);
    } finally {
        tearDown();
    }
});

test('a new swipe supersedes the one still snapping', () => {
    const { view, state, commits } = fakeView();
    const { tracker } = setUp(view, state);
    try {
        swipe(tracker, 1);
        tracker.emit('begin', 1);

        assert.equal(view.scrollAdjustment.transition, null, 'the snap was stopped');

        view.prepareToLeaveOverview();
        assert.deepEqual(commits, [], 'the superseded target is not committed');

        tracker.emit('end', 300, 2);
        view.scrollAdjustment.finish();
        assert.deepEqual(commits, [2]);
    } finally {
        tearDown();
    }
});

test('a swipe that snaps back to the active page commits nothing', () => {
    const { view, state, commits } = fakeView();
    const { tracker } = setUp(view, state);
    try {
        swipe(tracker, 0);
        view.scrollAdjustment.finish();
        view.prepareToLeaveOverview();

        assert.deepEqual(commits, []);
        assert.equal(state.activeIndex, 0);
    } finally {
        tearDown();
    }
});

test('activate() from a thumbnail or the wheel commits when it lands', () => {
    const { view, commits } = fakeView();

    view.activate(2);
    assert.equal(view.scrollAdjustment.transition.params.duration, 250);
    assert.deepEqual(commits, []);

    view.scrollAdjustment.finish();
    assert.deepEqual(commits, [2]);
});

test('activate() survives the overview closing mid-animation', () => {
    const { view, commits } = fakeView();

    view.activate(2);
    view.prepareToLeaveOverview();

    assert.deepEqual(commits, [2]);
    assert.equal(view.scrollAdjustment.value, 2);
});

test('activate() on the active page animates back without committing', () => {
    const { view, commits } = fakeView({ activeIndex: 1 });
    view.scrollAdjustment.value = 1.3;

    view.activate(1);
    assert.equal(view.scrollAdjustment.transition.target, 1);

    view.scrollAdjustment.finish();
    view.prepareToLeaveOverview();
    assert.deepEqual(commits, []);
});

test('prepareToLeaveOverview() with nothing in flight only forwards to pages', () => {
    const { view, commits } = fakeView({ activeIndex: 1 });

    view.prepareToLeaveOverview();

    assert.deepEqual(commits, []);
    assert.equal(view.scrollAdjustment.value, 1);
    assert.ok(view._pages.every(page => page.left === 1));
});

// --- Finding: clicking a peeking neighbour page closes the overview ---------

/** A page of `view`, the way the view builds them: tagged, and its child. */
function fakeWorkspace(view, state, index, overviewState = 1) {
    const page = new Workspace();
    if (index !== null)
        page[VIRTUAL] = { state, index };
    page._overviewAdjustment = { value: overviewState };
    page.get_parent = () => view;
    return page;
}

test('clicking a neighbour page switches to it and keeps the overview', () => {
    const { view, state, commits } = fakeView();
    setUp(view, state);
    try {
        assert.equal(fakeWorkspace(view, state, 2)._shouldLeaveOverview(), false);
        assert.equal(view.scrollAdjustment.transition.target, 2);

        view.scrollAdjustment.finish();
        assert.deepEqual(commits, [2]);
    } finally {
        tearDown();
    }
});

test('clicking the centred page still leaves the overview, switching nothing', () => {
    const { view, state, commits } = fakeView({ activeIndex: 1 });
    setUp(view, state);
    try {
        assert.equal(fakeWorkspace(view, state, 1)._shouldLeaveOverview(), true);

        view.prepareToLeaveOverview();
        assert.deepEqual(commits, []);
        assert.equal(state.activeIndex, 1);
        assert.equal(view.scrollAdjustment.value, 1);
    } finally {
        tearDown();
    }
});

test('clicking the active page while a switch is in flight goes back to it', () => {
    const { view, state, commits } = fakeView();
    setUp(view, state);
    try {
        view.activate(2);

        assert.equal(fakeWorkspace(view, state, 0)._shouldLeaveOverview(), true);

        // The overview closing must not commit the switch the click undid.
        view.prepareToLeaveOverview();
        assert.deepEqual(commits, []);
        assert.equal(state.activeIndex, 0);
        assert.equal(view.scrollAdjustment.value, 0);
    } finally {
        tearDown();
    }
});

test('from the app grid, a page click leaves the overview as the shell does', () => {
    const { view, state, commits } = fakeView();
    setUp(view, state);
    try {
        assert.equal(fakeWorkspace(view, state, 2, 2)._shouldLeaveOverview(), true);
        assert.equal(view.scrollAdjustment.transition, null, 'no switch started');
        assert.deepEqual(commits, []);
    } finally {
        tearDown();
    }
});

test('pages we did not build keep the shell\'s own answer', () => {
    const { view, state } = fakeView();
    setUp(view, state);
    try {
        const page = fakeWorkspace(view, state, null);
        const window = { title: 'primary' };

        assert.equal(page._shouldLeaveOverview(), 'original');
        page._onCloneSelected({ metaWindow: window }, 7);
        assert.equal(page.originalSelected, true);
        assert.deepEqual(activated, [[window, 7, undefined]]);
        assert.equal(view.scrollAdjustment.transition, null);
    } finally {
        tearDown();
    }
});

test('clicking a window on a neighbour page still goes to that window', () => {
    const { view, state, commits } = fakeView();
    setUp(view, state);
    try {
        const page = fakeWorkspace(view, state, 2);
        const window = { title: 'parked' };

        page._onCloneSelected({ metaWindow: window }, 42);

        assert.deepEqual(activated, [[window, 42, undefined]]);
        assert.equal(view.scrollAdjustment.transition, null,
            'no switch of its own: the window brings its workspace');
        assert.deepEqual(commits, []);
        assert.equal(page.originalSelected, undefined);
    } finally {
        tearDown();
    }
});

// --- Finding: RTL centres the mirror-image page ---------------------------

function allocate(view) {
    const box = new ActorBox();
    box.set_size(1920, 1080);
    view.vfunc_allocate(box);
    return view._pages.map(page => page.box.x1);
}

// 1920 wide, 1000-wide pages: centred at 460, spacing (460 - 400) = 60.
test('LTR lays the pages out left to right from the active one', () => {
    const { view } = fakeView({ activeIndex: 0 });

    assert.deepEqual(allocate(view), [460, 1520, 2580]);
});

test('RTL centres the active page and lays the rest out to its left', () => {
    const { view } = fakeView({ activeIndex: 0 });
    view.text_direction = Clutter.TextDirection.RTL;

    assert.deepEqual(allocate(view), [460, -600, -1660]);
});

test('RTL mid-row: the active page is centred, earlier ones to its right', () => {
    const { view } = fakeView({ activeIndex: 1 });
    view.text_direction = Clutter.TextDirection.RTL;

    assert.deepEqual(allocate(view), [1520, 460, -600]);
});
