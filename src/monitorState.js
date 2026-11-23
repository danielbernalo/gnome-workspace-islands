// With workspaces-only-on-primary, secondary windows are sticky; a virtual workspace is a shown set.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { hide, show, isHiddenByUs } from './visibility.js';
import { appKeyOf } from './persistence.js';
import { stamp, placementIndex } from './placement.js';
import { isManageable } from './windowFilter.js';

// Below 2, overview.js and slide.js treat the monitor as having no virtual workspaces.
const MIN_SIZE = 2;

// Bounds sizes read from gsettings so a corrupt saved index cannot allocate inside enable().
const MAX_RESTORE_SIZE = 36;

export class MonitorState {
    constructor(connector, dynamic = false) {
        this.connector = connector;
        this.activeIndex = 0;
        this._dynamic = dynamic;
        this._groups = Array.from({ length: MIN_SIZE }, () => new Set());
        this._appRules = new Map();

        // Restored rules with no window yet; their empty workspace may be reclaimed.
        this._unconfirmedApps = new Set();

        // Restored rules that lost their workspace, in saved order; each claims a fresh one.
        this._pendingApps = new Set();

        this._sizeListeners = new Set();
    }

    setDynamic(dynamic) {
        this._dynamic = dynamic;
    }

    onSizeChanged(callback) {
        this._sizeListeners.add(callback);
        return () => this._sizeListeners.delete(callback);
    }

    _notifySizeChanged() {
        for (const listener of this._sizeListeners)
            listener();
    }

    // Pending rules go past the end so a restore grows empty workspaces and re-pends them.
    get appRules() {
        const rules = Object.fromEntries(this._appRules);

        let next = this.size;
        for (const key of this._pendingApps)
            rules[key] = next++;

        return rules;
    }

    restore({ activeIndex = 0, apps = {} } = {}) {
        // Saved JSON is untrusted: null or non-integers would throw inside enable() on every login.
        if (!Number.isInteger(activeIndex))
            activeIndex = 0;
        if (!apps || typeof apps !== 'object')
            apps = {};

        if (this._dynamic)
            this._growForRestore(activeIndex, apps);

        this.activeIndex = clamp(activeIndex, 0, this.size - 1);

        this._appRules = new Map(
            Object.entries(apps)
                .filter(([, index]) => Number.isInteger(index))
                .map(([key, index]) => [key, clamp(index, 0, this.size - 1)])
        );
        this._unconfirmedApps = new Set(this._appRules.keys());
        this._pendingApps = new Set();
    }

    // activeIndex counts here: in dynamic mode the user often sits on the empty spare.
    _growForRestore(activeIndex, apps) {
        // reduce(), not Math.max(...spread): the array length comes from gsettings.
        const needed = [activeIndex, ...Object.values(apps)]
            .filter(Number.isInteger)
            .reduce((size, index) => Math.max(size, index + 1), MIN_SIZE);

        this.resize(Math.min(needed, MAX_RESTORE_SIZE));
    }

    rememberApp(window, index) {
        const key = appKeyOf(window);
        if (!key)
            return;

        this._appRules.set(key, index);
        this._pendingApps.delete(key);
        this._unconfirmedApps.delete(key);
    }

    // A pending rule adopts this index so the app's next window joins this one.
    _confirmApp(window, index) {
        const key = appKeyOf(window);
        if (!key)
            return;

        this._unconfirmedApps.delete(key);
        if (this._pendingApps.delete(key))
            this._appRules.set(key, index);
    }

    // A pending rule resolves to the last workspace, the dynamic spare that is guaranteed fresh.
    indexForApp(window) {
        const key = appKeyOf(window);
        if (!key)
            return -1;

        if (this._pendingApps.has(key))
            return this.size - 1;

        if (!this._appRules.has(key))
            return -1;

        return clamp(this._appRules.get(key), 0, this.size - 1);
    }

    indexForPlacement(window) {
        const index = placementIndex(window, this.connector);

        // A note can outlive a shrink, since resize() only reaches windows that are in a group.
        return index < 0 ? -1 : clamp(index, 0, this.size - 1);
    }

    // Dynamic monitors are sized from saved rules, not notes; clamping would merge workspaces for good.
    _growForPlacement(window) {
        if (!this._dynamic)
            return;

        const index = placementIndex(window, this.connector);
        if (index >= this.size)
            this.resize(Math.min(index + 1, MAX_RESTORE_SIZE));
    }

    // The only way into a group: membership and note are written together, which detach() relies on.
    _place(window, index) {
        this._groups[index].add(window);
        stamp(window, this.connector, index);

        // Cleared here so a window is reclaimed at most once per disconnect, however it got back.
        this._detached?.delete(window);
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

    get allWindows() {
        return this._groups.flatMap(group => [...group]);
    }

    indexOf(window) {
        return this._groups.findIndex(group => group.has(window));
    }

    // The placement note outranks the app rule; rule-first collapses an app's windows after a resume.
    track(window, index = -1, { trustPlacement = true } = {}) {
        // Refused here, not only by callers: every way into a group, overview drops included, ends here.
        if (this.indexOf(window) !== -1 || !isManageable(window))
            return -1;

        let target = index;
        if (target < 0 || target >= this.size) {
            target = -1;
            if (trustPlacement) {
                this._growForPlacement(window);
                target = this.indexForPlacement(window);
            }
        }
        if (target < 0)
            target = this.indexForApp(window);
        if (target < 0)
            target = this.activeIndex;

        this._place(window, target);
        this._confirmApp(window, target);
        this._growIfNeeded(target);

        if (target !== this.activeIndex)
            hide(window);

        return target;
    }

    // Batch callers skip reconcile: collapsing mid-batch strands notes of windows already released.
    untrack(window, { reconcile = true } = {}) {
        const from = this.indexOf(window);

        for (const group of this._groups)
            group.delete(window);

        if (from !== -1 && reconcile)
            this._reconcileEmpties();
    }

    // Show before hiding: the reverse flashes an empty desktop.
    switchTo(index, { animate = true } = {}) {
        if (index < 0 || index >= this.size || index === this.activeIndex)
            return false;

        for (const window of this.windowsOn(index))
            show(window, { animate });

        for (const window of this.windowsOn(this.activeIndex))
            hide(window, { animate });

        this.activeIndex = index;

        this._reconcileEmpties();

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
        this._growIfNeeded(index);

        this.rememberApp(window, index);

        if (index === this.activeIndex)
            show(window);
        else
            hide(window);

        this._reconcileEmpties();

        return true;
    }

    // Never animated: it realigns the screen with a model that changed underneath, e.g. at unlock.
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

    // Must be total: a window left parked after unload is invisible and unreachable.
    restoreAll() {
        for (const window of this.allWindows) {
            if (isHiddenByUs(window))
                show(window, { animate: false });
        }
    }

    // Groups are cleared so two monitors never own one window; the notes become the only record.
    detach() {
        // Redundant while _place() is the only way in; kept because notes are now the sole record.
        for (let index = 0; index < this.size; index++) {
            for (const window of this.windowsOn(index))
                stamp(window, this.connector, index);
        }

        // Added to, never replaced: pruneDetached() re-detaches absent monitors with empty groups.
        this._detached ??= new WeakSet();
        for (const window of this.allWindows)
            this._detached.add(window);

        this.restoreAll();

        for (const group of this._groups)
            group.clear();
    }

    // Detached means owed a ride home, unlike a window the user moved away that still has a note.
    wasDetached(window) {
        return this._detached?.has(window) ?? false;
    }

    resize(size) {
        if (size === this.size || size < MIN_SIZE)
            return;

        if (size > this.size) {
            while (this._groups.length < size)
                this._groups.push(new Set());
        } else {
            const tail = this._groups.splice(size);
            for (const group of tail) {
                for (const window of group)
                    this._place(window, size - 1);
            }

            if (this.activeIndex >= size)
                this.activeIndex = size - 1;

            // A fold can land parked windows on the visible workspace; show only what we parked.
            if (this.activeIndex === size - 1) {
                for (const window of this.windowsOn(size - 1)) {
                    if (isHiddenByUs(window))
                        show(window, { animate: false });
                }
            }

            for (const [key, index] of this._appRules) {
                if (index >= size)
                    this._appRules.set(key, size - 1);
            }
        }

        this._notifySizeChanged();
    }

    _growIfNeeded(index) {
        if (this._dynamic && index === this.size - 1)
            this.resize(this.size + 1);
    }

    // Like native dynamic workspaces: empties go, except the active one and the trailing spare.
    _reconcileEmpties() {
        if (!this._dynamic)
            return;

        const lastIndex = this.size - 1;
        const removable = [];
        for (let i = 0; i < this.size; i++) {
            if (i === this.activeIndex || i === lastIndex)
                continue;
            if (this._groups[i].size === 0)
                removable.push(i);
        }
        if (removable.length === 0)
            return;

        const toRemove = new Set(removable.slice(0, Math.max(0, this.size - MIN_SIZE)));
        if (toRemove.size === 0)
            return;

        // Re-stamp moved windows so notes match the new indices; _place() is not involved in a re-index.
        const oldToNew = new Map();
        const newGroups = [];
        for (let i = 0; i < this.size; i++) {
            if (toRemove.has(i))
                continue;

            const newIndex = newGroups.length;
            oldToNew.set(i, newIndex);
            newGroups.push(this._groups[i]);

            if (i !== newIndex) {
                for (const window of this._groups[i])
                    stamp(window, this.connector, newIndex);
            }
        }

        this._groups = newGroups;
        this.activeIndex = oldToNew.get(this.activeIndex);

        // Unconfirmed restored rules become pending instead of dropped, as does one on the empty spare.
        const newAppRules = new Map();
        const homeless = [];
        for (const [key, oldIndex] of this._appRules) {
            if (oldToNew.has(oldIndex))
                newAppRules.set(key, oldToNew.get(oldIndex));
            else if (this._unconfirmedApps.has(key))
                homeless.push([key, oldIndex]);
        }

        const newLast = newGroups.length - 1;
        if (newGroups[newLast].size === 0) {
            for (const [key, index] of newAppRules) {
                if (index === newLast && this._unconfirmedApps.has(key)) {
                    newAppRules.delete(key);
                    homeless.push([key, lastIndex]);
                }
            }
        }

        homeless.sort(([, a], [, b]) => a - b);
        for (const [key] of homeless)
            this._pendingApps.add(key);

        this._appRules = newAppRules;

        this._notifySizeChanged();
    }

    reconcileSize() {
        this._reconcileEmpties();

        // Saving on the spare restores two trailing empties; drop one or the count grows every unlock.
        const last = this.size - 1;
        if (this._dynamic && this.activeIndex === last - 1 &&
            this._groups[last].size === 0 && this._groups[last - 1].size === 0)
            this.resize(last);

        // Ensure a spare when the last workspace is occupied, e.g. after switching from fixed mode.
        if (this._dynamic && this._groups[this.size - 1].size > 0)
            this.resize(this.size + 1);
    }
}

export class Registry {
    constructor(fixedCount, dynamic, saved = { monitors: {} }) {
        this._fixedCount = fixedCount;
        this._dynamic = dynamic;
        this._states = new Map();

        this._heldFocus = null;

        // Kept, not applied once: a monitor plugged in later must get its saved arrangement too.
        this._saved = saved;
    }

    _createState(connector) {
        const state = new MonitorState(connector, this._dynamic);

        // Size fixed monitors before restore(), which clamps rather than grows them.
        if (!this._dynamic)
            state.resize(this._fixedCount);

        // A bad saved blob must not fail enable() on every login; start this monitor fresh.
        const saved = this._saved?.monitors?.[connector];
        if (saved) {
            try {
                state.restore(saved);
            } catch (error) {
                console.warn(`workspace-islands: ignoring saved state for ${connector}: ${error}`);
            }
        }

        this._states.set(connector, state);
        return state;
    }

    get fixedCount() {
        return this._fixedCount;
    }

    get states() {
        return [...this._states.values()];
    }

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

    setFixedCount(count) {
        this._fixedCount = count;
        if (this._dynamic)
            return;

        for (const state of this._states.values())
            state.resize(count);
    }

    setDynamic(dynamic) {
        this._dynamic = dynamic;
        for (const state of this._states.values()) {
            state.setDynamic(dynamic);
            if (dynamic)
                state.reconcileSize();
            else
                state.resize(this._fixedCount);
        }
    }

    forConnector(connector) {
        return this._states.get(connector) ?? null;
    }

    // Total on purpose: a group left holding a dead window would minimize() it on the next reapply().
    untrackEverywhere(window) {
        for (const state of this._states.values())
            state.untrack(window);
    }

    // Window-left-monitor signals are ignored during a layout change, so strays are dropped here.
    releaseStrays() {
        for (const state of this._states.values()) {
            for (const window of state.allWindows) {
                if (this.forWindow(window) !== state)
                    state.untrack(window, { reconcile: false });
            }
        }
    }

    // Parked windows that no group holds would otherwise stay minimized forever.
    restoreOrphans(windows) {
        for (const window of windows) {
            if (isHiddenByUs(window) && !this.states.some(state => state.indexOf(window) !== -1))
                show(window, { animate: false });
        }
    }

    // Keeps shortcuts on this monitor after it switched to an empty workspace and focus was unset.
    holdFocus(connector) {
        this._heldFocus = connector;
    }

    ensureConnector(connector) {
        if (!this._states.has(connector))
            this._createState(connector);

        return this._states.get(connector);
    }

    forMonitorIndex(index) {
        if (index < 0 || index === Main.layoutManager.primaryIndex)
            return null;

        if (!Main.layoutManager.monitors[index])
            return null;

        return this.forConnector(connectorOf(index));
    }

    forWindow(window) {
        const index = window.get_monitor();
        if (index < 0 || index === Main.layoutManager.primaryIndex)
            return null;

        if (!Main.layoutManager.monitors[index])
            return null;

        return this.forConnector(connectorOf(index));
    }

    // Focus decides, not the pointer: shortcuts come from the keyboard; the pointer is a fallback.
    forFocusedMonitor() {
        if (this._heldFocus && !global.display.focus_window)
            return this.forConnector(this._heldFocus);

        const index = focusedMonitorIndex();
        if (index < 0 || index === Main.layoutManager.primaryIndex)
            return null;

        if (!Main.layoutManager.monitors[index])
            return null;

        return this.forConnector(connectorOf(index));
    }

    // The pointer decides here: wheel input comes from the mouse, unlike shortcuts.
    forPointerMonitor() {
        return this.forMonitorIndex(global.display.get_current_monitor());
    }

    describeFocusTarget() {
        const focused = global.display.focus_window;
        const index = focusedMonitorIndex();
        const primary = Main.layoutManager.primaryIndex;
        const source = focused ? `window "${focused.get_title()}"` : 'pointer';

        return `${source} -> monitor ${index}` +
            (index === primary ? ' (PRIMARY — shortcut is a no-op here)' : '');
    }

    // State is kept, not deleted: it holds the arrangement to restore when the display returns.
    pruneDetached(live) {
        for (const [connector, state] of this._states) {
            if (!live.has(connector))
                state.detach();
        }

        if (this._heldFocus && !live.has(this._heldFocus))
            this._heldFocus = null;
    }

    // Groups alone are not enough: a tagged window may sit in no group (see restoreOrphans).
    restoreAll(windows = []) {
        for (const state of this._states.values())
            state.restoreAll();

        this.restoreOrphans(windows);
    }

    clear() {
        this._states.clear();
    }
}

// Cached: the indicator resolves the focused monitor on every frame of a swipe preview.
let connectors = null;

// The shell's Monitor has no name; connectors come from the backend so hotplug keeps keys stable.
export function connectorOf(index) {
    connectors ??= readConnectors();
    return connectors[index] ?? `monitor-${index}`;
}

// Call whenever the monitor layout is about to change.
export function invalidateConnectors() {
    connectors = null;
}

function readConnectors() {
    const map = [];

    try {
        const manager = global.backend.get_monitor_manager();

        for (const monitor of manager.get_monitors()) {
            if (!monitor.is_active())
                continue;

            const connector = monitor.get_connector();
            if (!connector)
                continue;

            const index = manager.get_monitor_for_connector(connector);
            if (index >= 0)
                map[index] = connector;
        }
    } catch (e) {
        console.warn(`workspace-islands: could not read monitor connectors: ${e}`);
    }

    return map;
}

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
