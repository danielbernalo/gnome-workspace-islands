/**
 * Super + wheel on a secondary monitor, driven through the real override.
 *
 * The default stubs swallow everything a shell module is asked for, including
 * the InjectionManager — so an override would install into nothing and never
 * run. These tests swap in just enough of the shell for scroll.js to patch a
 * real prototype: a WindowManager that is also `Main.wm`, the way it is in the
 * shell, and a GLib whose timers only fire when the test says so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const fakes = {};
globalThis.__wiFakes = fakes;


const Clutter = {
    ScrollDirection: { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, SMOOTH: 4 },
    EVENT_PROPAGATE: false,
    EVENT_STOP: true,
};

/** Timers that fire only on request, so "within 150 ms" is exact. */
const timers = new Map();
let nextTimer = 1;
const GLib = {
    PRIORITY_DEFAULT: 0,
    timeout_add_once(_priority, _ms, callback) {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
    },
    Source: {
        remove(id) {
            timers.delete(id);
        },
    },
};

function fireTimers() {
    for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
    }
}

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

class WindowManager {
    constructor() {
        this._canScroll = true;
        this.shellCalls = 0;
    }

    handleWorkspaceScroll() {
        this.shellCalls++;
        return 'shell';
    }
}

const wm = new WindowManager();

fakes['gi://Clutter'] = { default: Clutter };
fakes['gi://GLib'] = { default: GLib };
fakes['resource:///org/gnome/shell/extensions/extension.js'] = { InjectionManager };
fakes['resource:///org/gnome/shell/ui/main.js'] = { wm };
fakes['resource:///org/gnome/shell/ui/windowManager.js'] = { WindowManager };


const Scroll = await import('../src/scroll.js');

const notch = direction => ({ get_scroll_direction: () => direction });

/** Patch with a secondary-monitor state whose switches the test records. */
function setUp({ size = 4, activeIndex = 0, secondary = true } = {}) {
    const state = { connector: 'HDMI-1', size, activeIndex };
    const switches = [];

    Scroll.patch({
        getState: () => (secondary ? state : null),
        onScroll: (s, to, forward) => {
            switches.push([to, forward]);
            s.activeIndex = to;
        },
        log: () => {},
    });

    return { state, switches };
}

function tearDown() {
    Scroll.unpatch();
    timers.clear();
    wm._canScroll = true;
    wm.shellCalls = 0;
}

test('a second notch inside the 150 ms hold does not switch again', () => {
    const { state, switches } = setUp();
    try {
        assert.equal(wm.handleWorkspaceScroll(notch(Clutter.ScrollDirection.DOWN)),
            Clutter.EVENT_STOP);
        assert.equal(wm._canScroll, false, 'the wheel is held after a switch');
        assert.equal(timers.size, 1);

        assert.equal(wm.handleWorkspaceScroll(notch(Clutter.ScrollDirection.DOWN)),
            Clutter.EVENT_PROPAGATE);

        assert.deepEqual(switches, [[1, true]]);
        assert.equal(state.activeIndex, 1);
        assert.equal(wm._canScroll, false);
        assert.equal(wm.shellCalls, 0, 'the shell never saw the secondary wheel');
    } finally {
        tearDown();
    }
});

test('the hold lets go after its timeout, and the next notch switches', () => {
    const { state, switches } = setUp();
    try {
        wm.handleWorkspaceScroll(notch(Clutter.ScrollDirection.DOWN));
        fireTimers();

        assert.equal(wm._canScroll, true);

        wm.handleWorkspaceScroll(notch(Clutter.ScrollDirection.DOWN));

        assert.deepEqual(switches, [[1, true], [2, true]]);
        assert.equal(state.activeIndex, 2);
        assert.equal(timers.size, 1, 'one hold at a time');
    } finally {
        tearDown();
    }
});

test('a notch past the end is clamped, still claimed, and still held', () => {
    const { state, switches } = setUp({ activeIndex: 3 });
    try {
        assert.equal(wm.handleWorkspaceScroll(notch(Clutter.ScrollDirection.DOWN)),
            Clutter.EVENT_STOP);

        assert.deepEqual(switches, []);
        assert.equal(state.activeIndex, 3);
        assert.equal(wm._canScroll, false);
        assert.equal(wm.shellCalls, 0);
    } finally {
        tearDown();
    }
});

test('unpatch() during a hold drops the timer and hands the wheel back', () => {
    setUp();
    wm.handleWorkspaceScroll(notch(Clutter.ScrollDirection.DOWN));

    Scroll.unpatch();

    assert.equal(wm._canScroll, true);
    assert.equal(timers.size, 0);
    assert.equal(wm.handleWorkspaceScroll(notch(Clutter.ScrollDirection.DOWN)), 'shell',
        'the original method is back');
    tearDown();
});

test('the primary monitor keeps the shell\'s own wheel', () => {
    const { switches } = setUp({ secondary: false });
    try {
        assert.equal(wm.handleWorkspaceScroll(notch(Clutter.ScrollDirection.DOWN)), 'shell');
        assert.equal(wm.shellCalls, 1);
        assert.deepEqual(switches, []);
        assert.equal(timers.size, 0);
    } finally {
        tearDown();
    }
});
