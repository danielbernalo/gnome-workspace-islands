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
 * because indices are reshuffled on hotplug while connectors are stable. The
 * name comes from the backend, not from the shell's `Monitor` — see
 * {@link connectorOf}, which is where that distinction was once lost.
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { hide, show, isHiddenByUs } from './visibility.js';
import { appKeyOf } from './persistence.js';
import { stamp, placementIndex } from './placement.js';

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

    /** Where this exact window was on this monitor, or -1 if we have no note. */
    indexForPlacement(window) {
        const index = placementIndex(window, this.connector);

        // Clamped like indexForApp, and for a sharper reason: a note can
        // outlive a shrink of `virtual-workspaces`, because resize() can only
        // reach windows that are in a group at the time.
        return index < 0 ? -1 : clamp(index, 0, this.size - 1);
    }

    /**
     * The one way into a group: membership and note are written together.
     *
     * Private so that "a window in a group carries a current note" is an
     * invariant rather than a habit. detach() depends on it — see there.
     */
    _place(window, index) {
        this._groups[index].add(window);
        stamp(window, this.connector, index);
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
     * Four answers, in descending order of how much they actually know:
     *
     *   explicit index   a drop or a move. The user just said where.
     *   placement note   this exact window was on workspace N of this exact
     *                    monitor, and something churned in between — a lock
     *                    screen, an unplug, a resume. Not a guess: a record.
     *   app rule         a window we have never seen, of an app we have. A
     *                    guess, and a good one.
     *   active index     nothing is known. Put it where the user is looking.
     *
     * The note outranks the rule because they answer different questions. The
     * rule says "windows of this app usually live on 3"; the note says "this
     * window was on 2, four hundred milliseconds ago". A resume that consulted
     * the rule first collapses every window of an app into one workspace, which
     * is the entire bug this ordering exists to prevent.
     *
     * A window that lands somewhere other than the active workspace is hidden
     * immediately — otherwise it appears on screen for a moment and then
     * vanishes, which reads as a bug.
     *
     * @param {object} [options]
     * @param {boolean} [options.trustPlacement] consult the note. False for a
     *   window the user just dragged here: a drag is a statement about *now*,
     *   and honouring an old note would make the window they are holding
     *   vanish onto some workspace they are not looking at. Every other caller
     *   is recovering from churn, where the note is the whole point.
     * @returns {number} the index it was assigned to, or -1 if already tracked
     */
    track(window, index = -1, { trustPlacement = true } = {}) {
        if (this.indexOf(window) !== -1)
            return -1;

        let target = index;
        if (target < 0 || target >= this.size)
            target = trustPlacement ? this.indexForPlacement(window) : -1;
        if (target < 0)
            target = this.indexForApp(window);
        if (target < 0)
            target = this.activeIndex;

        this._place(window, target);

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
        this._place(window, index);

        // Moving a window by hand is the strongest signal we get about where
        // its application belongs, so it updates the rule.
        this.rememberApp(window, index);

        if (index === this.activeIndex)
            show(window);
        else
            hide(window);

        return true;
    }

    /**
     * Apply the current active index to every window this monitor holds.
     *
     * Instant, never animated. This runs at enable() and after a hotplug —
     * always "bring the screen in line with a model that changed underneath
     * it", never a transition the user asked to watch. Animated, an unlock
     * would open with every window on every inactive workspace minimizing
     * itself in sequence.
     */
    reapply() {
        for (let i = 0; i < this.size; i++) {
            for (const window of this.windowsOn(i)) {
                if (i === this.activeIndex)
                    show(window, { animate: false });
                else
                    hide(window, { animate: false });
            }
        }
    }

    /** Put every window back on screen. Must be total — see visibility.js. */
    restoreAll() {
        for (const window of this.allWindows) {
            if (isHiddenByUs(window))
                show(window, { animate: false });
        }
    }

    /**
     * Release the windows but keep the arrangement.
     *
     * Used when the monitor is unplugged: its windows have already been moved
     * to another monitor by Mutter, and any we had hidden are still minimized
     * — invisible on a monitor that has no virtual workspaces to explain why.
     * They get shown and dropped.
     *
     * The groups really are cleared, and that is deliberate. Keeping them would
     * mean two monitors owning the same window: the display that took the
     * windows tracks them, and this one would still hold them and minimize them
     * on its next switch — a window on the other screen vanishing for no
     * visible reason. The note replaces the group; it does not supplement it.
     *
     * Re-stamping first is what makes the unplug survivable. Every window in a
     * group is already stamped — _place() is the only way in — so the loop is
     * redundant today, and it is written out anyway because this is the one
     * place where the note stops being a second copy of the group and becomes
     * the only surviving record of it. A future edit that finds another way
     * into a group should fail here, not silently on the next dock.
     */
    detach() {
        for (let index = 0; index < this.size; index++) {
            for (const window of this.windowsOn(index))
                stamp(window, this.connector, index);
        }

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
        for (const group of tail) {
            for (const window of group)
                this._place(window, size - 1);
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

        Main.layoutManager.monitors.forEach((_monitor, index) => {
            if (index === primaryIndex)
                return;

            const connector = connectorOf(index);
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

    /**
     * Drop a window from every state. For a window that is going away.
     *
     * Bookkeeping only — no un-hiding, because there is nothing left to show.
     * Total on purpose: a dying window's monitor is not worth asking about, and
     * a group left holding one would minimize() it on the next reapply().
     */
    untrackEverywhere(window) {
        for (const state of this._states.values())
            state.untrack(window);
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

        if (!Main.layoutManager.monitors[index])
            return null;

        return this.forConnector(connectorOf(index));
    }

    /** State for the monitor a window sits on, or null if it is on primary. */
    forWindow(window) {
        const index = window.get_monitor();
        if (index < 0 || index === Main.layoutManager.primaryIndex)
            return null;

        if (!Main.layoutManager.monitors[index])
            return null;

        return this.forConnector(connectorOf(index));
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

        if (!Main.layoutManager.monitors[index])
            return null;

        return this.forConnector(connectorOf(index));
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

/**
 * The connector driving a monitor index — "HDMI-2", not "monitor-1".
 *
 * This module is keyed by connector precisely because indices are reshuffled on
 * hotplug. Until now that was an intention rather than a fact: the shell's
 * `Monitor` is `(index, geometry, scale)` and carries no name, so
 * `monitor.connector` was always undefined and every key fell through to the
 * positional fallback. The model was keyed by index after all — unplug a
 * display, plug it back in second instead of first, and "the LG's workspace 3"
 * was restored onto whatever now sat at index 1.
 *
 * The name has to come from the backend. `get_monitor_for_connector` answers
 * with the logical monitor index a connector currently drives, and that is the
 * same index space `Main.layoutManager.monitors` uses, so one pass over the
 * attached monitors gives exactly the mapping this module always assumed it had.
 */
export function connectorOf(index) {
    try {
        const manager = global.backend.get_monitor_manager();

        for (const monitor of manager.get_monitors()) {
            if (!monitor.is_active())
                continue;

            const connector = monitor.get_connector();
            if (connector && manager.get_monitor_for_connector(connector) === index)
                return connector;
        }
    } catch (e) {
        // A backend that cannot name its monitors is not a reason to stop
        // working. Positional keys are what this did before, and they are right
        // for as long as nothing is unplugged.
        console.warn(`workspace-islands: could not read monitor connectors: ${e}`);
    }

    return `monitor-${index}`;
}

/**
 * Current index for a connector, or -1 if that display is not attached.
 *
 * Lives here rather than in the two modules that had identical private copies:
 * both were scanning a monitor list that does not know its own names.
 */
export function monitorIndexOf(connector) {
    return Main.layoutManager.monitors.findIndex(
        (_monitor, index) => connectorOf(index) === connector);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

function focusedMonitorIndex() {
    const focused = global.display.focus_window;
    return focused ? focused.get_monitor() : global.display.get_current_monitor();
}
