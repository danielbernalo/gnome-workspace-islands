import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MonitorState, Registry } from '../src/monitorState.js';

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
