/**
 * Persistence across sessions and hotplug.
 *
 * A hard limit shapes this module: **windows have no stable identity across
 * sessions**. A MetaWindow is a live object; nothing about it survives a
 * logout, and no id can be trusted to mean the same window tomorrow. So
 * "restore this window to virtual workspace 2" is not implementable *here*.
 *
 * Note the emphasis on *across sessions*. Almost nothing that loses an
 * arrangement is a new session — a lock, a suspend, a monitor unplugged over
 * lunch all happen inside one, where the MetaWindow objects are the same
 * objects and the exact mapping is recoverable. That case is not this module's
 * to solve and it is not lost; see placement.js, which puts the record on the
 * window instead of in gsettings precisely because it must not outlive it.
 *
 * What is implementable here, and what people actually mean when they ask for
 * a setup that survives a logout:
 *
 *   activeIndex   which virtual workspace each monitor was left on. Restoring
 *                 this is what makes the setup feel like it stayed put.
 *
 *   app rules     the last virtual workspace a given application was placed
 *                 on, keyed by WM_CLASS. New windows of that app land there
 *                 instead of always defaulting to whatever is active. This is
 *                 a heuristic, deliberately: two windows of the same app go to
 *                 the same place, which is usually right and never surprising
 *                 in a way the user cannot correct by moving the window.
 *
 * Keyed by monitor connector, so a display that comes back after being
 * unplugged returns to its own arrangement rather than a default one.
 *
 * Stored as JSON in a single gsettings string. The shape is versioned so a
 * future format change can migrate instead of throwing away the user's setup.
 */

import GLib from 'gi://GLib';

const STATE_KEY = 'saved-state';
const VERSION = 1;

/** Debounce window. Switching workspaces should not hit gsettings each time. */
const SAVE_DELAY_MS = 2000;

export class Persistence {
    constructor(settings) {
        this._settings = settings;
        this._saveId = 0;

        // What saved-state holds, per connector, as of the last load or save.
        // A save merges into this rather than replacing it — see saveNow().
        this._monitors = {};
    }

    /**
     * @returns {{monitors: Object<string, {activeIndex: number, apps: Object<string, number>}>}}
     */
    load() {
        this._monitors = {};

        const raw = this._settings.get_string(STATE_KEY);
        if (!raw)
            return { monitors: {} };

        try {
            const parsed = JSON.parse(raw);
            if (parsed?.version !== VERSION || typeof parsed.monitors !== 'object')
                return { monitors: {} };

            // Only a plain object is a usable merge base. An array would be
            // spread into keys "0", "1"… and written back as monitors.
            if (parsed.monitors && !Array.isArray(parsed.monitors))
                this._monitors = { ...parsed.monitors };

            return { monitors: parsed.monitors ?? {} };
        } catch (e) {
            // Corrupt state must never take the extension down with it.
            console.warn(`workspace-islands: discarding unreadable saved state: ${e}`);
            return { monitors: {} };
        }
    }

    /** Collapse rapid changes into one write. */
    scheduleSave(registry) {
        if (this._saveId)
            GLib.Source.remove(this._saveId);

        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this.saveNow(registry);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Write the live arrangement over the saved one, connector by connector.
     *
     * Merged, not rebuilt. The registry only holds the monitors this enable()
     * has seen, and saved-state is the only place the others live: the
     * display at home while you are at the office, or the dock unplugged
     * before a lock tore this extension down and built it back without it.
     * Rebuilding from the registry alone would erase each of those on the
     * first save, which is exactly the "returns to its own arrangement"
     * promise in the header broken by the act of keeping it.
     */
    saveNow(registry) {
        const monitors = { ...this._monitors };

        for (const state of registry.states) {
            monitors[state.connector] = {
                activeIndex: state.activeIndex,
                apps: state.appRules,
            };
        }

        try {
            this._settings.set_string(STATE_KEY, JSON.stringify({
                version: VERSION,
                monitors,
            }));
            this._monitors = monitors;
        } catch (e) {
            console.warn(`workspace-islands: could not save state: ${e}`);
        }
    }

    /**
     * Write now and stop the timer. Call from disable().
     *
     * Unconditional, not only when a save is pending. Not every change to the
     * model schedules one — a window closing on an inactive workspace in
     * dynamic mode collapses that workspace and shifts the active index
     * underneath everything after it — and disable() is the last moment the
     * live model exists. A lock is a disable, so skipping the write here would
     * restore the stale index at unlock and park the window the user was
     * looking at. Safe only because saveNow() merges: a rebuild-from-registry
     * save on every lock would erase every monitor not attached at the time.
     */
    flush(registry) {
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }

        if (registry)
            this.saveNow(registry);
    }

    destroy() {
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }
    }
}

/**
 * WM_CLASS, normalised. Null for windows that have none — those get no rule
 * rather than sharing an empty-string bucket with every other classless window.
 */
export function appKeyOf(window) {
    const wmClass = window.get_wm_class();
    return wmClass ? wmClass.toLowerCase() : null;
}
