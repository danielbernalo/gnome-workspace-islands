/**
 * Who owns a minimized window, and what is written to saved-state.
 *
 * The first half pins the promise visibility.js opens with: only windows the
 * extension minimized are ever un-minimized by it. The second half pins what
 * persistence.js writes, through a settings object that just keeps a string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MonitorState, Registry } from '../src/monitorState.js';
import { Persistence } from '../src/persistence.js';
import { hide, show, reveal, forget, isHiddenByUs } from '../src/visibility.js';
import { FakeWindow } from './support/fakes.mjs';

function fixedState(size = 4) {
    const state = new MonitorState('HDMI-1', false);
    state.resize(size);
    return state;
}

/** A window on the active workspace that the user then minimized by hand. */
function userMinimizedOn(state) {
    const window = new FakeWindow();
    state.track(window);
    window.minimize();
    return window;
}

test('a window the user minimized stays minimized across a switch away and back', () => {
    const state = fixedState();
    const window = userMinimizedOn(state);

    state.switchTo(1);
    assert.equal(window.minimized, true);
    // Parked like every other window there, so Alt+Tab and the overview
    // still treat it as living on another workspace.
    assert.equal(isHiddenByUs(window), true);

    state.switchTo(0);
    assert.equal(window.minimized, true);
    assert.equal(isHiddenByUs(window), false);
});

test('disable() leaves a window the user minimized minimized', () => {
    const state = fixedState();
    const window = userMinimizedOn(state);
    state.switchTo(1);

    state.restoreAll();

    assert.equal(window.minimized, true);
    assert.equal(isHiddenByUs(window), false);
});

test('reapply() leaves a user-minimized window on the active workspace alone', () => {
    const state = fixedState();
    const window = userMinimizedOn(state);

    state.reapply();

    assert.equal(window.minimized, true);
    assert.equal(isHiddenByUs(window), false);
});

test('a user-minimized window survives disable() and enable()', () => {
    const state = fixedState();
    const window = userMinimizedOn(state);
    state.switchTo(1);
    state.restoreAll();

    // enable(): a new state adopts the same window and applies the index.
    const next = fixedState();
    next.restore({ activeIndex: 1 });
    next.track(window);
    next.reapply();
    next.switchTo(0);

    assert.equal(window.minimized, true);
    assert.equal(isHiddenByUs(window), false);
});

test('windows the extension hid are still restored', () => {
    const state = fixedState();
    const parked = new FakeWindow();
    const other = new FakeWindow();
    state.track(parked, 1);
    state.track(other, 2);
    assert.equal(parked.minimized, true);

    state.switchTo(1);
    assert.equal(parked.minimized, false);
    assert.equal(isHiddenByUs(parked), false);

    state.restoreAll();
    assert.equal(other.minimized, false);
    assert.equal(isHiddenByUs(other), false);
});

test('a window un-minimized from outside is ours to park again after forget()', () => {
    const window = new FakeWindow({ minimized: true });
    hide(window, { animate: false });

    // The dash brings it back; extension.js forgets the tag.
    window.unminimize();
    forget(window);

    hide(window, { animate: false });
    assert.equal(window.minimized, true);
    show(window, { animate: false });
    assert.equal(window.minimized, false);
});

test('a slide preview does not un-minimize a window the user minimized', () => {
    const window = new FakeWindow({ minimized: true });
    hide(window, { animate: false });

    reveal(window);
    assert.equal(window.minimized, true);

    // slide.js _settle() on a page it did not land on, then a later switch.
    hide(window, { animate: false });
    show(window, { animate: false });
    assert.equal(window.minimized, true);
});

test('a slide preview still reveals and re-hides a window the extension hid', () => {
    const window = new FakeWindow();
    hide(window, { animate: false });

    reveal(window);
    assert.equal(window.minimized, false);
    assert.equal(isHiddenByUs(window), true);

    hide(window, { animate: false });
    assert.equal(window.minimized, true);
    assert.equal(isHiddenByUs(window), true);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

class FakeSettings {
    constructor(value = '') {
        this.value = value;
    }

    get_string() {
        return this.value;
    }

    set_string(_key, value) {
        this.value = value;
    }
}

const blob = monitors => JSON.stringify({ version: 1, monitors });
const written = settings => JSON.parse(settings.value).monitors;

test('saving keeps the arrangement of monitors that are not attached', () => {
    const home = { activeIndex: 2, apps: { slack: 1 } };
    const settings = new FakeSettings(blob({ 'HDMI-1': home, 'DP-3': { activeIndex: 0, apps: {} } }));
    const persistence = new Persistence(settings);

    const registry = new Registry(4, false, persistence.load());
    registry._createState('DP-3').switchTo(1);

    persistence.saveNow(registry);
    assert.deepEqual(written(settings), {
        'HDMI-1': home,
        'DP-3': { activeIndex: 1, apps: {} },
    });

    // And a later save builds on that, not on the blob as first loaded.
    registry.forConnector('DP-3').switchTo(3);
    persistence.saveNow(registry);
    assert.deepEqual(written(settings)['HDMI-1'], home);
    assert.equal(written(settings)['DP-3'].activeIndex, 3);
});

test('saving over a malformed blob writes only the live monitors', () => {
    const settings = new FakeSettings(JSON.stringify({ version: 1, monitors: ['x'] }));
    const persistence = new Persistence(settings);

    const registry = new Registry(4, false, persistence.load());
    registry._createState('DP-3');
    persistence.saveNow(registry);

    assert.deepEqual(written(settings), { 'DP-3': { activeIndex: 0, apps: {} } });
});

test('flush() writes the live model even with no save pending', () => {
    // Dynamic [A][B][C][D][spare] on D, saved. B then closes on its own,
    // which shifts the active index with nobody scheduling a save.
    const settings = new FakeSettings(blob({ 'HDMI-1': { activeIndex: 3, apps: {} } }));
    const persistence = new Persistence(settings);
    const registry = new Registry(4, true, persistence.load());
    const state = registry._createState('HDMI-1');

    const windows = [0, 1, 2, 3].map(() => new FakeWindow());
    windows.forEach((window, index) => state.track(window, index));
    registry.untrackEverywhere(windows[1]);
    assert.equal(state.activeIndex, 2);

    persistence.flush(registry);

    assert.equal(written(settings)['HDMI-1'].activeIndex, 2);
});
