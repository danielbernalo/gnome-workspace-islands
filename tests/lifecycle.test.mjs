// Fakes behave like Mutter and GNOME Shell 51, except the fake never hands focus on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeWindow } from './support/fakes.mjs';

class Emitter {
    constructor() {
        this._handlers = new Map();
        this._nextId = 1;
    }

    connect(signal, handler) {
        const id = this._nextId++;
        this._handlers.set(id, [signal, handler]);
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    connectedSignals() {
        return [...this._handlers.values()].map(([signal]) => signal);
    }

    emit(signal, ...args) {
        for (const [name, handler] of [...this._handlers.values()]) {
            if (name === signal)
                handler(this, ...args);
        }
    }
}

const display = new Emitter();
display.focus_window = null;
display.pointerMonitor = 0;
display.unsetFocusCount = 0;
display.get_current_monitor = () => display.pointerMonitor;
// Bottom to top. Windows stack in the order they were created.
display.sort_windows_by_stacking = windows => [...windows].sort((a, b) => a.id - b.id);
display.unset_input_focus = () => {
    display.focus_window = null;
    display.unsetFocusCount++;
    display.emit('notify::focus-window');
};

/** What the backend reports: index -> connector, in its own rebuilt layout. */
let outputs = [];

const monitorManager = new Emitter();
monitorManager.get_monitors = () => outputs.map(connector => ({
    is_active: () => connector !== null,
    get_connector: () => connector,
}));
monitorManager.get_monitor_for_connector = connector => outputs.indexOf(connector);

const layoutManager = new Emitter();
layoutManager.primaryIndex = 0;
layoutManager.monitors = [];

let windows = [];

Object.assign(globalThis, {
    display,
    backend: { get_monitor_manager: () => monitorManager },
    get_window_actors: () => windows.map(window => ({ meta_window: window })),
    get_current_time: () => 0,
});

/** GLib timeouts are held, not run: a test fires the settle when it wants. */
const timers = new Map();
let nextTimer = 1;
const GLib = {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    timeout_add(_priority, _ms, callback) {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
    },
    Source: {
        remove: id => timers.delete(id),
        set_name_by_id() {},
    },
};

const Main = {
    layoutManager,
    sessionMode: { isLocked: false },
    notifyError() {},
    wm: { addKeybinding: () => 1, removeKeybinding() {}, skipNextEffect() {} },
};

// These fakes must be in place before src/ is imported; everything else gets the inert stub.

globalThis.__wiFakes = {
    'gi://GLib': { default: GLib },
    'resource:///org/gnome/shell/ui/main.js': Main,
};

const { default: WorkspaceIslands } = await import('../src/extension.js');
const { Registry, invalidateConnectors } = await import('../src/monitorState.js');
const { placementIndex } = await import('../src/placement.js');
const { hide, isHiddenByUs } = await import('../src/visibility.js');

class ShellWindow extends FakeWindow {
    constructor(options) {
        super(options);
        this._signals = new Emitter();
    }

    connect(signal, handler) {
        return this._signals.connect(signal, handler);
    }

    disconnect(id) {
        this._signals.disconnect(id);
    }

    connectedSignals() {
        return this._signals.connectedSignals();
    }

    minimize() {
        const was = this.minimized;
        super.minimize();
        if (was !== this.minimized)
            this._signals.emit('notify::minimized');
    }

    unminimize() {
        const was = this.minimized;
        super.unminimize();
        if (was !== this.minimized)
            this._signals.emit('notify::minimized');
    }

    activate() {
        this.unminimize();
        display.focus_window = this;
        display.emit('notify::focus-window');
    }

    /** Mutter moving it: the pair of signals, left first. */
    move_to_monitor(index) {
        const from = this._monitor;
        this._monitor = index;
        display.emit('window-left-monitor', from, this);
        display.emit('window-entered-monitor', index, this);
    }
}

class FakeSettings extends Emitter {
    constructor(values) {
        super();
        this._values = { ...values };
    }

    get_boolean(key) { return Boolean(this._values[key]); }
    get_int(key) { return this._values[key]; }
    get_strv(key) { return this._values[key] ?? []; }

    set(key, value) {
        this._values[key] = value;
        this.emit(`changed::${key}`, key);
    }
}

class FakeKeys {
    constructor() {
        this.handlers = new Map();
    }

    add(name, handler) {
        this.handlers.set(name, handler);
        return true;
    }

    removeAll() {
        this.handlers.clear();
    }
}

const SWITCH_KEYS = {
    'switch-to-1': ['<Super><Alt>1'],
    'switch-to-2': ['<Super><Alt>2'],
    'switch-to-3': ['<Super><Alt>3'],
    'switch-to-4': ['<Super><Alt>4'],
};

function setLayout(connectors) {
    outputs = ['eDP-1', ...connectors];
    layoutManager.monitors = outputs.map((_c, index) => ({ index }));
}

function makeExtension({ dynamic = false, count = 4, debug = false, settings = {} } = {}) {
    timers.clear();
    windows = [];
    display.focus_window = null;
    display.pointerMonitor = 0;
    display.unsetFocusCount = 0;
    display._handlers.clear();
    monitorManager._handlers.clear();
    layoutManager._handlers.clear();
    setLayout(['HDMI-1']);
    invalidateConnectors();

    const ext = Object.create(WorkspaceIslands.prototype);
    Object.assign(ext, {
        _settings: new FakeSettings({
            'virtual-workspaces': count,
            'dynamic-virtual-workspaces': dynamic,
            'debug-logging': debug,
            ...SWITCH_KEYS,
            ...settings,
        }),
        _mutterSettings: new FakeSettings({ 'workspaces-only-on-primary': true }),
        _persistence: null,
        _registry: new Registry(count, dynamic),
        _windowSignals: new Map(),
        _signals: [],
        _settleId: 0,
        _layoutChanging: false,
        _keys: new FakeKeys(),
        _indicator: null,
        _popup: null,
        _slide: null,
    });

    ext._registry.syncMonitors();
    ext._connectSignals();
    ext._bindKeys();
    return ext;
}

function open(options = {}) {
    const window = new ShellWindow({ monitor: 1, ...options });
    windows.push(window);
    display.emit('window-created', window);
    return window;
}

function arrange(ext) {
    const state = ext._registry.forConnector('HDMI-1');
    const [a, b, c] = ['a', 'b', 'c'].map(wmClass => open({ wmClass }));

    state.moveWindowTo(b, 1);
    state.moveWindowTo(c, 2);
    state.switchTo(1);

    return { state, a, b, c };
}

// A display change, in the order Mutter and the shell really produce it.
function changeLayout(connectors, moves, untouched = []) {
    monitorManager.emit('monitors-changing');

    outputs = ['eDP-1', ...connectors];

    for (const window of windows) {
        const to = moves.get(window) ?? (untouched.includes(window) ? window._monitor : null);
        if (to === null)
            continue;

        const from = window._monitor;
        window._monitor = to;
        display.emit('window-left-monitor', from, window);
        display.emit('window-entered-monitor', to, window);
    }

    layoutManager.monitors = outputs.map((_c, index) => ({ index }));
    layoutManager.emit('monitors-changed');
}

function settle() {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending)
        callback();
}

function isParked(window) {
    return window.minimized && isHiddenByUs(window);
}

function isShown(window) {
    return !window.minimized && !isHiddenByUs(window);
}

for (const dynamic of [false, true]) {
    const mode = dynamic ? 'dynamic' : 'fixed';

    test(`unplugging a monitor shows every window it had parked (${mode})`, () => {
        const ext = makeExtension({ dynamic });
        const { state, a, b, c } = arrange(ext);
        assert.ok(isParked(a) && isShown(b) && isParked(c));

        changeLayout([], new Map([[a, 0], [b, 0], [c, 0]]));

        for (const window of [a, b, c]) {
            assert.equal(isShown(window), true, `${window} is on screen`);
            assert.equal(state.wasDetached(window), true, `${window} is owed a ride home`);
            assert.equal(state.indexOf(window), -1);
        }

        settle();

        for (const window of [a, b, c])
            assert.equal(isShown(window), true, `${window} is still on screen`);
    });

    test(`unplugging keeps every note and the active workspace (${mode})`, () => {
        const ext = makeExtension({ dynamic });
        const { state, a, b, c } = arrange(ext);

        changeLayout([], new Map([[a, 0], [b, 0], [c, 0]]));
        settle();

        assert.equal(placementIndex(a, 'HDMI-1'), 0);
        assert.equal(placementIndex(b, 'HDMI-1'), 1);
        assert.equal(placementIndex(c, 'HDMI-1'), 2);
        assert.equal(state.activeIndex, 1);
    });

    test(`replugging puts every window back where it was (${mode})`, () => {
        const ext = makeExtension({ dynamic });
        const { state, a, b, c } = arrange(ext);

        changeLayout([], new Map([[a, 0], [b, 0], [c, 0]]));
        settle();
        changeLayout(['HDMI-1'], new Map([[a, 1], [b, 1], [c, 1]]));
        settle();

        assert.deepEqual([state.indexOf(a), state.indexOf(b), state.indexOf(c)], [0, 1, 2]);
        assert.equal(state.activeIndex, 1);
        assert.ok(isParked(a) && isShown(b) && isParked(c));
    });

    test(`a monitor that returns under Mutter's radar reclaims its windows (${mode})`, () => {
        const ext = makeExtension({ dynamic });
        const { state, a, b, c } = arrange(ext);

        changeLayout([], new Map([[a, 0], [b, 0], [c, 0]]));
        settle();

        // Back, but Mutter leaves the windows on the laptop panel.
        changeLayout(['HDMI-1'], new Map());
        settle();

        for (const window of [a, b, c])
            assert.equal(window.get_monitor(), 1, `${window} was moved back`);
        assert.deepEqual([state.indexOf(a), state.indexOf(b), state.indexOf(c)], [0, 1, 2]);
        assert.ok(isParked(a) && isShown(b) && isParked(c));
    });

    test(`a resume that re-announces every window loses nothing (${mode})`, () => {
        const ext = makeExtension({ dynamic });
        const { state, a, b, c } = arrange(ext);

        changeLayout(['HDMI-1'], new Map(), [a, b, c]);
        settle();

        assert.deepEqual([state.indexOf(a), state.indexOf(b), state.indexOf(c)], [0, 1, 2]);
        assert.deepEqual(
            [a, b, c].map(window => placementIndex(window, 'HDMI-1')), [0, 1, 2]);
        assert.equal(state.activeIndex, 1);
        assert.ok(isParked(a) && isShown(b) && isParked(c));
    });
}

test('dynamic: a resume does not merge single-window workspaces (#36)', () => {
    const ext = makeExtension({ dynamic: true });
    const state = ext._registry.forConnector('HDMI-1');
    const [ff, term, ed] = ['firefox', 'terminal', 'editor'].map(wmClass => open({ wmClass }));
    state.moveWindowTo(term, 1);
    state.moveWindowTo(ed, 2);
    state.switchTo(1);
    assert.equal(state.size, 4);

    changeLayout(['HDMI-1'], new Map(), [ff, term, ed]);
    settle();

    assert.equal(state.size, 4);
    assert.deepEqual(state.windowsOn(0), [ff]);
    assert.deepEqual(state.windowsOn(1), [term]);
    assert.deepEqual(state.windowsOn(2), [ed]);
    assert.equal(state.activeIndex, 1);
});

test('dragging a window to another monitor still takes it out of its workspace', () => {
    const ext = makeExtension();
    const { state, b } = arrange(ext);

    b.move_to_monitor(0);

    assert.equal(state.indexOf(b), -1);
    assert.equal(isShown(b), true);
});

test('a window dragged onto the monitor lands on the workspace on screen', () => {
    const ext = makeExtension();
    const { state, a } = arrange(ext);
    const d = open({ wmClass: 'd' });
    d.move_to_monitor(0);
    state.switchTo(0);
    assert.equal(isShown(a), true);

    d.move_to_monitor(1);

    assert.equal(state.indexOf(d), 0);
    assert.equal(isShown(d), true);
});

test('a window moved to the primary during a layout change is not left parked', () => {
    const ext = makeExtension();
    const { state, a, b, c } = arrange(ext);

    // HDMI-1 stays, but Mutter puts a parked window on the primary.
    changeLayout(['HDMI-1'], new Map([[a, 0]]), [b, c]);
    settle();

    assert.equal(state.indexOf(a), -1);
    assert.equal(isShown(a), true);
    assert.equal(state.indexOf(c), 2);
    assert.equal(isParked(c), true);
});

test('disable() shows a window we parked even if no workspace holds it', () => {
    const ext = makeExtension();
    const { a, c } = arrange(ext);
    const stray = new ShellWindow({ monitor: 0 });
    windows.push(stray);
    hide(stray);

    ext.disable();

    for (const window of [a, c, stray])
        assert.equal(isShown(window), true, `${window} is on screen`);
});

test('disable() leaves a window the user minimized alone', () => {
    const ext = makeExtension();
    const primary = new ShellWindow({ monitor: 0 });
    windows.push(primary);
    primary.minimize();

    ext.disable();

    assert.equal(primary.minimized, true);
});

test('a switch-to shortcut assigned while running is registered', () => {
    const ext = makeExtension({ count: 6 });
    assert.equal(ext._keys.handlers.has('switch-to-5'), false);

    ext._settings.set('switch-to-5', ['<Super><Alt>5']);

    assert.equal(ext._keys.handlers.has('switch-to-5'), true);
});

test('a switch-to shortcut cleared while running is dropped', () => {
    const ext = makeExtension();
    assert.equal(ext._keys.handlers.has('switch-to-3'), true);

    ext._settings.set('switch-to-3', []);

    assert.equal(ext._keys.handlers.has('switch-to-3'), false);
});

test('a switch-to shortcut beyond the fixed count stays unregistered', () => {
    const ext = makeExtension({ count: 4 });

    ext._settings.set('switch-to-6', ['<Super><Alt>6']);

    assert.equal(ext._keys.handlers.has('switch-to-6'), false);
});

test('changing the count still rebinds the shortcuts', () => {
    const ext = makeExtension({ count: 4, settings: { 'switch-to-5': ['<Super><Alt>5'] } });
    assert.equal(ext._keys.handlers.has('switch-to-5'), false);

    ext._settings.set('virtual-workspaces', 5);

    assert.equal(ext._keys.handlers.has('switch-to-5'), true);
    assert.equal(ext._keys.handlers.has('switch-next'), true);
});

test('switching gives focus to the top window of the workspace switched to', () => {
    const ext = makeExtension();
    const state = ext._registry.forConnector('HDMI-1');
    const terminal = open({ wmClass: 'terminal' });
    const [lower, upper] = ['files', 'browser'].map(wmClass => open({ wmClass }));
    state.moveWindowTo(lower, 1);
    state.moveWindowTo(upper, 1);
    terminal.activate();

    ext._commitSwitch(state, 1, { slid: false, announce: false });

    assert.equal(display.focus_window, upper);
    assert.equal(isShown(upper), true);
});

test('switching to an empty workspace keeps the shortcuts on that monitor', () => {
    const ext = makeExtension();
    const state = ext._registry.forConnector('HDMI-1');
    const terminal = open({ wmClass: 'terminal' });
    terminal.activate();

    ext._commitSwitch(state, 1, { slid: false, announce: false });

    assert.equal(display.unsetFocusCount, 1);
    assert.equal(display.focus_window, null);
    assert.equal(ext._registry.forFocusedMonitor(), state);

    ext._switchTo(0);

    assert.equal(state.activeIndex, 0);
    assert.equal(display.focus_window, terminal);
});

test('once something else takes focus, the hold on the monitor is released', () => {
    const ext = makeExtension();
    const state = ext._registry.forConnector('HDMI-1');
    open({ wmClass: 'terminal' }).activate();
    ext._commitSwitch(state, 1, { slid: false, announce: false });

    const browser = new ShellWindow({ monitor: 0 });
    windows.push(browser);
    browser.activate();
    display.focus_window = null;
    display.emit('notify::focus-window');

    assert.equal(ext._registry.forFocusedMonitor(), null);
});

test('switching a monitor the user is not focused on leaves focus alone', () => {
    const ext = makeExtension();
    const state = ext._registry.forConnector('HDMI-1');
    const other = open({ wmClass: 'files' });
    state.moveWindowTo(other, 1);
    const browser = new ShellWindow({ monitor: 0 });
    windows.push(browser);
    browser.activate();

    ext._commitSwitch(state, 1, { slid: false, announce: false });

    assert.equal(display.focus_window, browser);
    assert.equal(display.unsetFocusCount, 0);
});

test('moving the focused window away hands focus to what is left on screen', () => {
    const ext = makeExtension();
    const state = ext._registry.forConnector('HDMI-1');
    const [files, terminal] = ['files', 'terminal'].map(wmClass => open({ wmClass }));
    terminal.activate();

    ext._moveFocused(1);

    assert.equal(state.indexOf(terminal), 1);
    assert.equal(isParked(terminal), true);
    assert.equal(display.focus_window, files);
});

function captureLog(callback) {
    const lines = [];
    const original = console.log;
    console.log = line => lines.push(String(line));
    try {
        callback();
    } finally {
        console.log = original;
    }
    return lines;
}

test('a move-window shortcut on the primary says why it did nothing', () => {
    const ext = makeExtension({ debug: true });
    const browser = new ShellWindow({ monitor: 0, wmClass: 'browser' });
    windows.push(browser);
    browser.activate();

    const lines = captureLog(() => ext._moveFocused(1));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /no-op: .*PRIMARY/);
});

test('a move-window shortcut with nothing focused says so', () => {
    const ext = makeExtension({ debug: true });

    const lines = captureLog(() => ext._moveFocused(1));

    assert.deepEqual(lines, ['workspace-islands: no-op: no focused window']);
});

test('a move-window shortcut on a window the model does not hold says so', () => {
    const ext = makeExtension({ debug: true });
    const dialog = new ShellWindow({ monitor: 1, type: 3, canMinimize: false, wmClass: 'zenity' });
    windows.push(dialog);
    dialog.activate();

    const lines = captureLog(() => ext._moveFocused(1));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /no-op: "zenity #\d+" is not tracked on HDMI-1/);
});

test('a switch shortcut on the primary still says why it did nothing', () => {
    const ext = makeExtension({ debug: true });
    const browser = new ShellWindow({ monitor: 0 });
    windows.push(browser);
    browser.activate();

    const lines = captureLog(() => ext._switchTo(1));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /no-op: .*PRIMARY/);
});

test('an unmanageable window is never adopted and never wired', () => {
    makeExtension();
    const desktop = open({ wmClass: 'ding', type: 1, canMinimize: false, skipTaskbar: true });

    assert.deepEqual(desktop.connectedSignals(), []);
});

test('a managed window is adopted and wired', () => {
    const ext = makeExtension();
    const window = open();

    assert.equal(ext._registry.forConnector('HDMI-1').indexOf(window), 0);
    assert.deepEqual(window.connectedSignals().sort(), ['notify::minimized', 'unmanaged']);
});

test('dropping an unmanageable window on a workspace does nothing', () => {
    const ext = makeExtension();
    const state = ext._registry.forConnector('HDMI-1');
    const dialog = open({ wmClass: 'zenity', type: 3, canMinimize: false });

    ext._dropWindow(state, 2, dialog, 1);

    assert.equal(state.indexOf(dialog), -1);
    assert.equal(isHiddenByUs(dialog), false);
    assert.deepEqual(dialog.connectedSignals(), []);
});

test('a window first filed by a drop gets the same signals as any other', () => {
    const ext = makeExtension();
    const state = ext._registry.forConnector('HDMI-1');
    // On the monitor but not in the model, the way a layout change leaves it.
    const window = new ShellWindow({ monitor: 1, wmClass: 'files' });
    windows.push(window);

    ext._dropWindow(state, 2, window, 1);

    assert.equal(state.indexOf(window), 2);
    assert.equal(isParked(window), true);
    assert.deepEqual(window.connectedSignals().sort(), ['notify::minimized', 'unmanaged']);
});

test('dropping a window from the primary still files it where it was dropped', () => {
    const ext = makeExtension();
    const state = ext._registry.forConnector('HDMI-1');
    const window = new ShellWindow({ monitor: 0, wmClass: 'files' });
    windows.push(window);

    ext._dropWindow(state, 2, window, 1);

    assert.equal(window.get_monitor(), 1);
    assert.equal(state.indexOf(window), 2);
    assert.equal(isParked(window), true);
});
