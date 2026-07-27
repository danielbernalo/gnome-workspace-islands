/**
 * Per-monitor virtual workspace state.
 *
 * Mutter has no notion of a workspace belonging to a monitor — a workspace
 * belongs to the display, and only one is active at a time. With
 * `workspaces-only-on-primary = true`, windows on secondary monitors are
 * sticky: they exist on every workspace and survive native workspace switches.
 *
 * That is what this module exploits. Those windows are always present, so the
 * only question left is which ones are *shown*. A "virtual workspace" is just a
 * set of windows we agree to show together.
 *
 * Monitors are keyed by `connector` (e.g. "HDMI-2") rather than by index,
 * because indices are reshuffled on hotplug while connectors are stable.
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { hide, show, isHiddenByUs } from './visibility.js';
import { appKeyOf } from './persistence.js';

export class MonitorState {
    constructor(connector, size) {
        this.connector = connector;
        this.activeIndex = 0;
        this._groups = Array.from({ length: size }, () => new Set());
        this._appRules = new Map();
    }

    /** Plain object for serialisation: WM_CLASS -> virtual workspace index. */
    get appRules() {
        return Object.fromEntries(this._appRules);
    }

    /** Restore a previously saved arrangement. Indices are clamped, not trusted. */
    restore({ activeIndex = 0, apps = {} } = {}) {
        this.activeIndex = clamp(activeIndex, 0, this.size - 1);

        this._appRules = new Map(
            Object.entries(apps)
                .filter(([, index]) => Number.isInteger(index))
                .map(([key, index]) => [key, clamp(index, 0, this.size - 1)])
        );
    }

    /** Remember where this window's application belongs. */
    rememberApp(window, index) {
        const key = appKeyOf(window);
        if (key)
            this._appRules.set(key, index);
    }

    /** Saved workspace for this window's application, or -1 if unknown. */
    indexForApp(window) {
        const key = appKeyOf(window);
        if (!key || !this._appRules.has(key))
            return -1;

        return clamp(this._appRules.get(key), 0, this.size - 1);
    }

    get size() {
        return this._groups.length;
    }

    windowsOn(index) {
        return [...(this._groups[index] ?? [])];
    }

    get activeWindows() {
        return this.windowsOn(this.activeIndex);
    }

    /** Every window this monitor knows about, in any virtual workspace. */
    get allWindows() {
        return this._groups.flatMap(group => [...group]);
    }

    indexOf(window) {
        return this._groups.findIndex(group => group.has(window));
    }

    /**
     * Assign a window to a virtual workspace.
     *
     * With no explicit index, an app rule decides; failing that, the active
     * workspace. A window that lands somewhere other than the active workspace
     * is hidden immediately — otherwise it appears on screen for a moment and
     * then vanishes, which reads as a bug.
     *
     * @returns {number} the index it was assigned to, or -1 if already tracked
     */
    track(window, index = -1) {
        if (this.indexOf(window) !== -1)
            return -1;

        let target = index;
        if (target < 0 || target >= this.size)
            target = this.indexForApp(window);
        if (target < 0)
            target = this.activeIndex;

        this._groups[target].add(window);

        if (target !== this.activeIndex)
            hide(window);

        return target;
    }

    untrack(window) {
        for (const group of this._groups)
            group.delete(window);
    }

    /**
     * Show the target group, hide the rest.
     *
     * Order matters: reveal first, then hide. Hiding first leaves a visible
     * flash of empty desktop between the two states.
     */
    switchTo(index, { animate = true } = {}) {
        if (index < 0 || index >= this.size || index === this.activeIndex)
            return false;

        for (const window of this.windowsOn(index))
            show(window, { animate });

        for (const window of this.windowsOn(this.activeIndex))
            hide(window, { animate });

        this.activeIndex = index;
        return true;
    }

    moveWindowTo(window, index) {
        if (index < 0 || index >= this.size)
            return false;

        const from = this.indexOf(window);
        if (from === -1 || from === index)
            return false;

        this._groups[from].delete(window);
        this._groups[index].add(window);

        // Moving a window by hand is the strongest signal we get about where
        // its application belongs, so it updates the rule.
        this.rememberApp(window, index);

        if (index === this.activeIndex)
            show(window);
        else
            hide(window);

        return true;
    }

    /** Apply the current active index to every window this monitor holds. */
    reapply() {
        for (let i = 0; i < this.size; i++) {
            for (const window of this.windowsOn(i)) {
                if (i === this.activeIndex)
                    show(window);
                else
                    hide(window);
            }
        }
    }

    /** Put every window back on screen. Must be total — see visibility.js. */
    restoreAll() {
        for (const window of this.allWindows) {
            if (isHiddenByUs(window))
                show(window);
        }
    }

    /**
     * Release the windows but keep the arrangement.
     *
     * Used when the monitor is unplugged: its windows have already been moved
     * to another monitor by Mutter, and any we had hidden are still minimized
     * — invisible on a monitor that has no virtual workspaces to explain why.
     * They get shown and dropped. activeIndex and the app rules survive, so
     * plugging the display back in restores its arrangement.
     */
    detach() {
        this.restoreAll();
        for (const group of this._groups)
            group.clear();
    }

    /** Resize the workspace count, folding anything beyond the new end. */
    resize(size) {
        if (size === this.size || size < 1)
            return;

        if (size > this.size) {
            while (this._groups.length < size)
                this._groups.push(new Set());
            return;
        }

        // Shrinking: everything past the new end collapses into the last group
        // rather than vanishing along with its windows.
        const tail = this._groups.splice(size);
        const last = this._groups[size - 1];
        for (const group of tail) {
            for (const window of group)
                last.add(window);
        }

        if (this.activeIndex >= size)
            this.activeIndex = size - 1;

        // Rules pointing past the new end would silently send windows nowhere.
        for (const [key, index] of this._appRules) {
            if (index >= size)
                this._appRules.set(key, size - 1);
        }
    }
}

export class Registry {
    constructor(size, saved = { monitors: {} }) {
        this._size = size;
        this._states = new Map();

        // Kept around rather than applied once: a monitor plugged in later in
        // the session must get its saved arrangement too, not a default one.
        this._saved = saved;
    }

    _createState(connector) {
        const state = new MonitorState(connector, this._size);

        const saved = this._saved?.monitors?.[connector];
        if (saved)
            state.restore(saved);

        this._states.set(connector, state);
        return state;
    }

    get size() {
        return this._size;
    }

    get states() {
        return [...this._states.values()];
    }

    /**
     * Rebuild the connector set from the current monitor layout.
     *
     * State for connectors that come back after a hotplug is preserved — the
     * windows are gone by then, but the active index and the user's mental
     * model of "workspace 3 on the LG" are not.
     */
    syncMonitors() {
        const primaryIndex = Main.layoutManager.primaryIndex;
        const live = new Set();

        Main.layoutManager.monitors.forEach((monitor, index) => {
            if (index === primaryIndex)
                return;

            const connector = connectorOf(monitor, index);
            live.add(connector);

            if (!this._states.has(connector))
                this._createState(connector);
        });

        return live;
    }

    resize(size) {
        this._size = size;
        for (const state of this._states.values())
            state.resize(size);
    }

    forConnector(connector) {
        return this._states.get(connector) ?? null;
    }

    /** Create state for a connector that is not currently attached. */
    ensureConnector(connector) {
        if (!this._states.has(connector))
            this._createState(connector);

        return this._states.get(connector);
    }

    /** State for a monitor index, or null if it is the primary or unknown. */
    forMonitorIndex(index) {
        if (index < 0 || index === Main.layoutManager.primaryIndex)
            return null;

        const monitor = Main.layoutManager.monitors[index];
        if (!monitor)
            return null;

        return this.forConnector(connectorOf(monitor, index));
    }

    /** State for the monitor a window sits on, or null if it is on primary. */
    forWindow(window) {
        const index = window.get_monitor();
        if (index < 0 || index === Main.layoutManager.primaryIndex)
            return null;

        const monitor = Main.layoutManager.monitors[index];
        if (!monitor)
            return null;

        return this.forConnector(connectorOf(monitor, index));
    }

    /**
     * State for the monitor the user is working on, or null if that's primary.
     *
     * The focused window decides, not the pointer. `get_current_monitor()`
     * follows the mouse, which means a shortcut pressed while the pointer
     * happens to rest over the primary monitor silently does nothing — the
     * hand is on the keyboard, not the mouse. Pointer position is only a
     * fallback for when nothing is focused at all.
     */
    forFocusedMonitor() {
        const index = focusedMonitorIndex();
        if (index < 0 || index === Main.layoutManager.primaryIndex)
            return null;

        const monitor = Main.layoutManager.monitors[index];
        if (!monitor)
            return null;

        return this.forConnector(connectorOf(monitor, index));
    }

    /** Human-readable resolution trace, for diagnosing "nothing happened". */
    describeFocusTarget() {
        const focused = global.display.focus_window;
        const index = focusedMonitorIndex();
        const primary = Main.layoutManager.primaryIndex;
        const source = focused ? `window "${focused.get_title()}"` : 'pointer';

        return `${source} -> monitor ${index}` +
            (index === primary ? ' (PRIMARY — shortcut is a no-op here)' : '');
    }

    /**
     * Release monitors that are no longer attached.
     *
     * Their state object is kept, not deleted: it holds the arrangement to
     * restore if the display comes back.
     */
    pruneDetached(live) {
        for (const [connector, state] of this._states) {
            if (!live.has(connector))
                state.detach();
        }
    }

    restoreAll() {
        for (const state of this._states.values())
            state.restoreAll();
    }

    clear() {
        this._states.clear();
    }
}

export function connectorOf(monitor, index) {
    return monitor.connector ?? `monitor-${index}`;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

function focusedMonitorIndex() {
    const focused = global.display.focus_window;
    return focused ? focused.get_monitor() : global.display.get_current_monitor();
}
