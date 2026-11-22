import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MonitorState, Registry } from '../src/monitorState.js';
import { stamp, placementIndex } from '../src/placement.js';
import { isHiddenByUs } from '../src/visibility.js';
import { FakeWindow } from './support/fakes.mjs';

function fixedState(size = 4) {
    const state = new MonitorState('HDMI-1', false);
    state.resize(size);
    return state;
}

const dynamicState = () => new MonitorState('HDMI-1', true);

test('restore() keeps a valid index and integer app rules (fixed)', () => {
    const state = fixedState();
    state.restore({ activeIndex: 3, apps: { a: 2, b: 1.5, c: 9 } });

    assert.equal(state.activeIndex, 3);
    assert.deepEqual([...state._appRules], [['a', 2], ['c', 3]]);
});

test('restore() clamps an out-of-range index (fixed)', () => {
    const state = fixedState();
    state.restore({ activeIndex: 7 });

    assert.equal(state.activeIndex, 3);
});

test('restore() grows a dynamic monitor to fit what it restores', () => {
    const state = dynamicState();
    state.restore({ activeIndex: 3, apps: { a: 5 } });

    assert.equal(state.activeIndex, 3);
    assert.equal(state.size, 6);
});

test('restore() caps dynamic growth', () => {
    const state = dynamicState();
    state.restore({ activeIndex: 1e9 });

    assert.ok(state.size <= 36);
});

for (const [mode, make] of [['fixed', fixedState], ['dynamic', dynamicState]]) {
    test(`restore() tolerates apps: null (${mode})`, () => {
        const state = make();
        state.restore({ activeIndex: 1, apps: null });

        assert.equal(state.activeIndex, 1);
    });

    for (const bad of [1.5, 'x', {}, NaN, Infinity, null, true]) {
        test(`restore() rejects activeIndex ${String(bad)} (${mode})`, () => {
            const state = make();
            state.restore({ activeIndex: bad });

            assert.equal(state.activeIndex, 0);
        });
    }
}

test('Registry builds a usable state from a malformed saved entry', () => {
    const saved = { version: 1, monitors: { 'HDMI-1': { activeIndex: 1.5, apps: null } } };
    const state = new Registry(4, false, saved)._createState('HDMI-1');

    assert.equal(state.activeIndex, 0);
    assert.equal(state.size, 4);
});

function noted(index, options) {
    const window = new FakeWindow(options);
    stamp(window, 'HDMI-1', index);
    return window;
}

const app = wmClass => new FakeWindow({ wmClass });

for (const order of [[2, 1, 0], [0, 1, 2]]) {
    test(`dynamic: windows re-adopted by note keep their workspace (order ${order})`, () => {
        const state = dynamicState();
        state.restore({ activeIndex: 0 });

        const windows = [0, 1, 2].map(index => noted(index));
        for (const index of order)
            state.track(windows[index]);
        state.reconcileSize();

        windows.forEach((window, index) => {
            assert.equal(state.indexOf(window), index);
            assert.equal(placementIndex(window, 'HDMI-1'), index);
            assert.equal(window.minimized, index !== 0);
            assert.equal(isHiddenByUs(window), index !== 0);
        });
        assert.equal(state.activeIndex, 0);
        assert.equal(state.size, 4);
    });
}

test('dynamic: a gap left by a window closed during the lock collapses', () => {
    const state = dynamicState();
    state.restore({ activeIndex: 0 });

    const high = noted(3);
    const low = noted(0);
    state.track(high);
    state.track(low);
    state.reconcileSize();

    assert.equal(state.indexOf(low), 0);
    assert.equal(state.indexOf(high), 1);
    assert.equal(placementIndex(high, 'HDMI-1'), 1);
    assert.equal(state.size, 3);
});

test('fixed: a note past the end still folds into the last workspace', () => {
    const state = fixedState(3);
    const window = noted(5);

    assert.equal(state.track(window), 2);
    assert.equal(placementIndex(window, 'HDMI-1'), 2);
    assert.equal(state.size, 3);
    assert.equal(window.minimized, true);
});

test('dynamic: restored app rules survive the enable-time reconcile', () => {
    const state = dynamicState();
    state.restore({ activeIndex: 0, apps: { slack: 1, chrome: 2, term: 3 } });
    state.reconcileSize();

    assert.equal(state.size, 2);
    assert.deepEqual(state.appRules, { slack: 2, chrome: 3, term: 4 });

    const chrome = app('chrome');
    const slack = app('slack');
    const term = app('term');
    assert.equal(state.track(chrome), 1);
    assert.equal(state.track(slack), 2);
    assert.equal(state.track(term), 3);
    assert.equal(state.size, 5);

    assert.equal(state.track(app('chrome')), 1);
    assert.deepEqual(state.appRules, { chrome: 1, slack: 2, term: 3 });
    for (const window of [chrome, slack, term])
        assert.equal(window.minimized, true);
});

test('dynamic: kept app rules round-trip through a save and a restore', () => {
    const first = dynamicState();
    first.restore({ activeIndex: 0, apps: { slack: 1, chrome: 2, term: 3 } });
    first.reconcileSize();

    const second = dynamicState();
    second.restore({ activeIndex: first.activeIndex, apps: first.appRules });
    second.reconcileSize();

    assert.deepEqual(second.appRules, first.appRules);
    assert.equal(second.size, 2);
});

test('dynamic: pending rules round-trip while the user sits on the spare', () => {
    const first = dynamicState();
    first.restore({ activeIndex: 0, apps: { foo: 1, bar: 2 } });
    const a = app('a');
    first.track(a);
    first.reconcileSize();
    first.switchTo(1);
    assert.equal(first.size, 2);

    const saved = { activeIndex: first.activeIndex, apps: first.appRules };
    const second = dynamicState();
    second.restore(saved);
    second.track(a);
    second.reapply();
    second.reconcileSize();

    assert.equal(second.size, 2);
    assert.equal(second.activeIndex, 1);
    assert.equal(second.indexOf(a), 0);
    assert.equal(a.minimized, true);
    assert.deepEqual(second.appRules, first.appRules);

    const foo = app('foo');
    assert.equal(second.track(foo), 1);
    assert.equal(foo.minimized, false);
    assert.equal(isHiddenByUs(foo), false);
    assert.equal(second.size, 3);
});

test('dynamic: an empty active workspace before an occupied one keeps the spare', () => {
    const state = dynamicState();
    state.restore({ activeIndex: 0 });
    const window = noted(1);
    state.track(window);
    state.reconcileSize();

    assert.equal(state.size, 3);
    assert.equal(state.activeIndex, 0);
    assert.equal(state.indexOf(window), 1);
    assert.equal(state.windowsOn(2).length, 0);
});

test('dynamic: a rule whose app has a window keeps its workspace at enable', () => {
    const state = dynamicState();
    state.restore({ activeIndex: 0, apps: { slack: 1 } });
    state.track(noted(1, { wmClass: 'slack' }));
    state.reconcileSize();

    assert.deepEqual(state.appRules, { slack: 1 });
    assert.equal(state.track(app('slack')), 1);
});

test('dynamic: emptying a workspace at runtime still drops its rule', () => {
    const state = dynamicState();
    state.track(app('a'));
    const x = app('x');
    const y = app('y');
    state.track(x);
    state.track(y);
    state.moveWindowTo(x, 1);
    state.moveWindowTo(y, 2);
    assert.deepEqual(state.appRules, { x: 1, y: 2 });

    state.untrack(x);

    assert.deepEqual(state.appRules, { y: 1 });
    assert.equal(state.indexOf(y), 1);
    assert.equal(state.size, 3);
});

test('lowering the count shows windows folded into the active workspace', () => {
    const state = fixedState(4);
    state.switchTo(2);

    const folded = new FakeWindow();
    state.track(folded, 3);
    assert.equal(folded.minimized, true);

    const userMinimized = new FakeWindow();
    state.track(userMinimized, 2);
    userMinimized.minimize();

    state.resize(3);

    assert.equal(state.indexOf(folded), 2);
    assert.equal(folded.minimized, false);
    assert.equal(isHiddenByUs(folded), false);
    assert.equal(userMinimized.minimized, true);
});

test('lowering the count below the active workspace shows what it lands on', () => {
    const state = fixedState(4);
    state.switchTo(3);

    const visible = new FakeWindow();
    const hidden = new FakeWindow();
    state.track(visible, 3);
    state.track(hidden, 2);

    state.resize(3);

    assert.equal(state.activeIndex, 2);
    for (const window of [visible, hidden]) {
        assert.equal(state.indexOf(window), 2);
        assert.equal(window.minimized, false);
        assert.equal(isHiddenByUs(window), false);
    }
});

test('lowering the count keeps windows folded into an inactive workspace hidden', () => {
    const state = fixedState(4);
    const window = new FakeWindow();
    state.track(window, 3);

    state.resize(3);

    assert.equal(state.indexOf(window), 2);
    assert.equal(window.minimized, true);
    assert.equal(isHiddenByUs(window), true);
});

test('turning dynamic off shows windows folded onto the active workspace', () => {
    const registry = new Registry(4, true);
    const state = registry._createState('HDMI-1');
    const windows = [0, 1, 2, 3, 4].map(() => new FakeWindow());
    windows.forEach((window, index) => state.track(window, index));
    state.switchTo(4);
    assert.equal(state.size, 6);

    registry.setDynamic(false);

    assert.equal(state.size, 4);
    assert.equal(state.activeIndex, 3);
    for (const window of [windows[3], windows[4]]) {
        assert.equal(state.indexOf(window), 3);
        assert.equal(window.minimized, false);
        assert.equal(isHiddenByUs(window), false);
    }
    assert.equal(windows[2].minimized, true);
});

test('a second detach keeps the record of windows owed a ride home', () => {
    const state = fixedState();
    const window = new FakeWindow();
    state.track(window, 1);

    state.detach();
    assert.equal(state.wasDetached(window), true);
    assert.equal(window.minimized, false);

    state.detach();
    assert.equal(state.wasDetached(window), true);

    state.track(window);
    assert.equal(state.wasDetached(window), false);
    assert.equal(state.indexOf(window), 1);
});

test('turning dynamic on adds an empty spare when every workspace is occupied', () => {
    const registry = new Registry(4, false);
    const state = registry._createState('HDMI-1');
    const windows = [0, 1, 2, 3].map(() => new FakeWindow());
    windows.forEach((window, index) => state.track(window, index));

    registry.setDynamic(true);

    assert.equal(state.size, 5);
    assert.equal(state.windowsOn(4).length, 0);
    windows.forEach((window, index) => assert.equal(state.indexOf(window), index));
});

test('turning dynamic on adds an empty spare after an occupied last workspace', () => {
    const registry = new Registry(4, false);
    const state = registry._createState('HDMI-1');
    const window = new FakeWindow();
    state.track(window, 3);

    registry.setDynamic(true);

    assert.equal(state.size, 3);
    assert.equal(state.indexOf(window), 1);
    assert.equal(state.windowsOn(2).length, 0);
});

test('turning dynamic on still trims empty workspaces', () => {
    const registry = new Registry(4, false);
    const state = registry._createState('HDMI-1');
    state.track(new FakeWindow());

    registry.setDynamic(true);

    assert.equal(state.size, 2);
    assert.equal(state.windowsOn(1).length, 0);
});
