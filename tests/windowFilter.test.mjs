/**
 * Which windows the model may hold (issue #18).
 *
 * The model hides a window by minimizing it, so a window Mutter will not
 * minimize can never be parked: it stays on screen while Alt+Tab and the
 * overview treat it as living on another workspace. The window types below
 * are the ones a secondary monitor really carries, built the way Mutter
 * describes them: `can_minimize()` is false for every type but NORMAL and for
 * every skip-taskbar window, and an attached dialog is a transient of its
 * parent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isManageable } from '../src/windowFilter.js';
import { MonitorState } from '../src/monitorState.js';
import { isHiddenByUs } from '../src/visibility.js';
import { FakeWindow } from './support/fakes.mjs';

// Meta.WindowType values, as Mutter numbers them.
const DESKTOP = 1;
const DOCK = 2;
const DIALOG = 3;
const MODAL_DIALOG = 4;

const parent = new FakeWindow({ wmClass: 'editor' });

const unmanageable = {
    'the desktop-icons window': () => new FakeWindow({
        wmClass: 'ding', type: DESKTOP, canMinimize: false, skipTaskbar: true,
    }),
    'a dock': () => new FakeWindow({
        wmClass: 'dock', type: DOCK, canMinimize: false, skipTaskbar: true,
    }),
    'an attached dialog': () => new FakeWindow({
        wmClass: 'editor', type: MODAL_DIALOG, canMinimize: false,
        skipTaskbar: true, attachedTo: parent,
    }),
    'a dialog with no parent': () => new FakeWindow({
        wmClass: 'zenity', type: DIALOG, canMinimize: false,
    }),
    'a normal window whose hints forbid minimizing': () => new FakeWindow({
        wmClass: 'kiosk', canMinimize: false,
    }),
    'a normal window transient for another': () => new FakeWindow({
        wmClass: 'editor', attachedTo: parent,
    }),
    'a skip-taskbar normal window': () => new FakeWindow({
        wmClass: 'tray', skipTaskbar: true,
    }),
    'an override-redirect popup': () => new FakeWindow({
        wmClass: 'tooltip', overrideRedirect: true,
    }),
};

test('a normal window is manageable', () => {
    assert.equal(isManageable(new FakeWindow()), true);
});

for (const [name, make] of Object.entries(unmanageable)) {
    test(`${name} is not manageable`, () => {
        assert.equal(isManageable(make()), false);
    });

    // track() is what every path into a group goes through, the overview
    // drop included, so this is the guard that cannot be bypassed.
    test(`track() refuses ${name}, even onto an inactive workspace`, () => {
        const state = new MonitorState('HDMI-1', false);
        state.resize(4);
        const window = make();

        assert.equal(state.track(window, 2), -1);
        assert.equal(state.indexOf(window), -1);
        assert.deepEqual(state.allWindows, []);
        assert.equal(isHiddenByUs(window), false);
        assert.equal(window.minimized, false);
    });
}

test('track() still parks a normal window on an inactive workspace', () => {
    const state = new MonitorState('HDMI-1', false);
    state.resize(4);
    const window = new FakeWindow();

    assert.equal(state.track(window, 2), 2);
    assert.equal(state.indexOf(window), 2);
    assert.equal(isHiddenByUs(window), true);
    assert.equal(window.minimized, true);
});

test('a refused window does not grow a dynamic monitor', () => {
    const state = new MonitorState('HDMI-1', true);
    const dialog = unmanageable['a dialog with no parent']();

    state.track(dialog, 1);

    assert.equal(state.size, 2);
});
