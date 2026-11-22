import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeWindow } from './support/fakes.mjs';
import * as slideModule from '../src/slide.js';

/**
 * The controller minus the one step that needs a live shell: taking over the
 * shell's SwipeTracker. Tests hand it a fake tracker and shell controller
 * instead, which is what that step would have wired up.
 */
class SlideController extends slideModule.SlideController {
    _takeOverTracker() {}
}

/**
 * A window as Mutter reports it to the shell's own clone code: a window is
 * "showing on its workspace" unless it, or an ancestor, is minimized.
 */
class ShownWindow extends FakeWindow {
    showing_on_its_workspace() {
        return !this.minimized;
    }
}

/**
 * The shell globals slide.js touches. `stack` is Mutter's stacking order,
 * bottom first, as `sort_windows_by_stacking` reports it.
 */
function installShell({ stack = [] } = {}) {
    const stage = {
        handlers: new Map(),
        nextId: 1,
        connect(signal, handler) {
            const id = this.nextId++;
            this.handlers.set(id, { signal, handler });
            return id;
        },
        disconnect(id) {
            this.handlers.delete(id);
        },
        emit(signal) {
            for (const { signal: name, handler } of [...this.handlers.values()]) {
                if (name === signal)
                    handler();
            }
        },
    };

    const shell = {
        stage,
        unredirect: 0,
        display: {
            bind_property() {},
            sort_windows_by_stacking(windows) {
                return [...windows].sort(
                    (a, b) => stack.indexOf(a) - stack.indexOf(b));
            },
        },
        compositor: {
            disable_unredirect() { shell.unredirect--; },
            enable_unredirect() { shell.unredirect++; },
        },
        workspace_manager: { layout_rows: 1 },
    };

    globalThis.stage = shell.stage;
    globalThis.display = shell.display;
    globalThis.compositor = shell.compositor;
    globalThis.workspace_manager = shell.workspace_manager;

    return shell;
}

/** A model state: only what the slide reads. */
function fakeState(groups, activeIndex = 0) {
    return {
        activeIndex,
        size: groups.length,
        indexOf: window => groups.findIndex(group => group.includes(window)),
    };
}

/** The cover of a running slide, with the calls a test wants to observe. */
function fakeSlide(pages, position = 0) {
    return {
        progress: position,
        baseDistance: 100,
        indices: pages,
        transitionsRemoved: 0,
        eased: [],
        destroyed: false,
        remove_all_transitions() { this.transitionsRemoved++; },
        ease_property(property, value, params) {
            this.eased.push({ property, value, params });
        },
        destroy() { this.destroyed = true; },
        getSnapPoints() { return pages.map((_page, i) => i); },
        progressFor(index) { return pages.indexOf(index); },
        indexAt(progress) {
            const clamped = Math.min(Math.max(progress, 0), pages.length - 1);
            return pages[Math.round(clamped)];
        },
    };
}

/**
 * SwipeTracker as shell 51 implements the part the slide depends on: a
 * confirmed swipe is SCROLLING until it ends, and turning `enabled` off while
 * SCROLLING interrupts it — 'end'(0, cancelProgress) is emitted synchronously,
 * then the state resets.
 */
function fakeTracker(controller) {
    return {
        state: 'NONE',
        _enabled: true,
        enabledLog: [],
        confirmed: [],
        orientation: null,
        cancelProgress: 0,
        get enabled() { return this._enabled; },
        set enabled(value) {
            if (this._enabled === value)
                return;
            this._enabled = value;
            this.enabledLog.push(value);
            if (!value && this.state === 'SCROLLING') {
                controller._onEnd(this, 0, this.cancelProgress);
                this.state = 'NONE';
            }
        },
        confirmSwipe(distance, snapPoints, progress, cancelProgress) {
            this.confirmed.push({ distance, snapPoints, progress, cancelProgress });
            this.cancelProgress = cancelProgress;
            this.state = 'SCROLLING';
        },
        destroy() {},
    };
}

/** The shell's WorkspaceAnimationController, reduced to what is delegated. */
function fakeShellController() {
    return {
        begins: [],
        ends: [],
        _switchWorkspaceBegin(tracker, monitor) { this.begins.push(monitor); },
        _switchWorkspaceUpdate() {},
        _switchWorkspaceEnd(tracker, duration, endProgress) {
            this.ends.push({ duration, endProgress });
        },
    };
}

function setup({ states, stack } = {}) {
    const shell = installShell({ stack });
    const commits = [];
    const progress = [];

    const controller = new SlideController({
        settings: { get_boolean: () => true },
        getState: monitorIndex => states?.[monitorIndex] ?? null,
        onCommit: (state, index, info) => commits.push({ state, index, info }),
        onProgress: (state, value) => progress.push({ state, value }),
    });

    const tracker = fakeTracker(controller);
    const shellController = fakeShellController();
    controller._tracker = tracker;
    controller._controller = shellController;
    controller._shellTracker = { enabled: false };

    return { shell, controller, tracker, shellController, commits, progress };
}

/** Put a keyboard slide in flight, as animateSwitch() leaves it. */
function runningSlide(controller, state, pages, { revealed = [] } = {}) {
    const slide = fakeSlide(pages, pages.indexOf(state.activeIndex));
    controller._session = { state, slide, revealed, gesture: false };
    return slide;
}

test('page clones are stacked in window stacking order, bottom first', () => {
    const browser = new ShownWindow();
    const terminal = new ShownWindow();
    const editor = new ShownWindow();
    // Tracked browser, terminal, editor; the user has since raised the browser.
    installShell({ stack: [terminal, editor, browser] });

    const order = slideModule.cloneOrder([browser, terminal, editor]);

    assert.deepEqual(order, [terminal, editor, browser]);
});

test('page clones skip windows the user minimized, and keep every other', () => {
    const shown = new ShownWindow();
    const userMinimized = new ShownWindow({ minimized: true });
    const alsoShown = new ShownWindow();
    installShell({ stack: [shown, userMinimized, alsoShown] });

    const order = slideModule.cloneOrder([shown, userMinimized, alsoShown]);

    assert.deepEqual(order, [shown, alsoShown]);
    assert.equal(userMinimized.minimized, true, 'the window itself is untouched');
});

test('a swipe on another monitor does not adopt a running slide', () => {
    const stateA = fakeState([[], []], 0);
    const stateB = fakeState([[], []], 0);
    const { controller, tracker, shellController, commits } =
        setup({ states: { 1: stateA, 2: stateB } });
    const slide = runningSlide(controller, stateA, [0, 1]);

    controller._onBegin(tracker, 2);

    assert.equal(controller._session.state, stateA, 'A keeps its slide');
    assert.equal(slide.transitionsRemoved, 0, 'A still lands on its own');
    assert.equal(controller._session.gesture, false, 'A still gets its OSD');
    assert.equal(controller._claimed, false);
    assert.deepEqual(tracker.confirmed, [], 'B does not drive A');
    assert.deepEqual(shellController.begins, [2], 'declined back to the shell');
    assert.deepEqual(commits, []);
});

test('a swipe on the same monitor still adopts its running slide', () => {
    const stateA = fakeState([[], []], 0);
    const { controller, tracker, shellController } =
        setup({ states: { 1: stateA } });
    const slide = runningSlide(controller, stateA, [0, 1]);
    slide.progress = 0.4;

    controller._onBegin(tracker, 1);

    assert.equal(controller._session.slide, slide);
    assert.equal(slide.transitionsRemoved, 1);
    assert.equal(controller._session.gesture, true);
    assert.equal(controller._claimed, true);
    assert.deepEqual(tracker.confirmed, [{
        distance: 100, snapPoints: [0, 1], progress: 0.4, cancelProgress: 0,
    }]);
    assert.deepEqual(shellController.begins, []);
});

test('cancelling a claimed gesture resets the tracker without committing', () => {
    const outgoing = new ShownWindow();
    const incoming = new ShownWindow();
    const stateA = fakeState([[outgoing], [incoming]], 0);
    const { shell, controller, tracker, shellController, commits, progress } =
        setup({ states: { 1: stateA } });
    const slide = runningSlide(controller, stateA, [0, 1], { revealed: [incoming] });
    controller._onBegin(tracker, 1);
    assert.equal(tracker.state, 'SCROLLING');

    controller.cancel();

    assert.equal(tracker.state, 'NONE', 'the next swipe gets its begin');
    assert.equal(tracker.enabled, true);
    assert.deepEqual(tracker.enabledLog, [false, true]);
    assert.deepEqual(commits, [], 'the interrupt does not commit');
    assert.deepEqual(slide.eased, [], 'nor animate the dropped slide');
    assert.deepEqual(shellController.ends, [{ duration: 0, endProgress: 0 }],
        'its end falls through to the shell, which has nothing to end');
    assert.equal(controller._session, null);
    assert.equal(controller._claimed, false);
    assert.equal(slide.destroyed, true);
    assert.equal(shell.unredirect, 1);
    assert.deepEqual(progress, [{ state: stateA, value: null }]);
    assert.equal(incoming.minimized, true, 'the previewed page is put back');
    assert.equal(outgoing.minimized, false);
});

test('cancelling a keyboard slide leaves the tracker alone', () => {
    const incoming = new ShownWindow();
    const stateA = fakeState([[], [incoming]], 0);
    const { controller, tracker, commits, progress } =
        setup({ states: { 1: stateA } });
    const slide = runningSlide(controller, stateA, [0, 1], { revealed: [incoming] });

    controller.cancel();

    assert.deepEqual(tracker.enabledLog, []);
    assert.deepEqual(commits, []);
    assert.equal(controller._session, null);
    assert.equal(slide.destroyed, true);
    assert.deepEqual(progress, [{ state: stateA, value: null }]);
    assert.equal(incoming.minimized, true);
});

test('cancelling a gesture does not re-enable a tracker the shell disabled', () => {
    const stateA = fakeState([[], []], 0);
    const { controller, tracker, commits } = setup({ states: { 1: stateA } });
    runningSlide(controller, stateA, [0, 1]);
    controller._onBegin(tracker, 1);
    // What the shell's own animateSwitch() or overview handler does.
    tracker._enabled = false;
    tracker.state = 'NONE';

    controller.cancel();

    assert.equal(tracker.enabled, false);
    assert.deepEqual(tracker.enabledLog, []);
    assert.deepEqual(commits, []);
    assert.equal(controller._session, null);
});

test('a key focus change leaves a keyboard slide running', () => {
    const stateA = fakeState([[], []], 0);
    const { shell, controller, commits } = setup({ states: { 1: stateA } });
    const slide = runningSlide(controller, stateA, [0, 1]);

    shell.stage.emit('notify::key-focus');

    assert.equal(controller._session?.slide, slide);
    assert.equal(slide.destroyed, false);
    assert.deepEqual(commits, []);
});

test('the key focus watch is connected, and dropped on destroy()', () => {
    const { shell, controller } = setup();
    const watching = () => [...shell.stage.handlers.values()]
        .filter(({ signal }) => signal === 'notify::key-focus').length;

    assert.equal(watching(), 1);

    controller.destroy();

    assert.equal(watching(), 0);
});
