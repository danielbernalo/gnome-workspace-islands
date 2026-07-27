/**
 * Persistence across sessions and hotplug.
 *
 * A hard limit shapes this module: **windows have no stable identity across
 * sessions**. A MetaWindow is a live object; nothing about it survives a
 * logout, and no id can be trusted to mean the same window tomorrow. So
 * "restore this window to virtual workspace 2" is not implementable.
 *
 * What is implementable, and what people actually mean when they ask for it:
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
    }

    /**
     * @returns {{monitors: Object<string, {activeIndex: number, apps: Object<string, number>}>}}
     */
    load() {
        const raw = this._settings.get_string(STATE_KEY);
        if (!raw)
            return { monitors: {} };

        try {
            const parsed = JSON.parse(raw);
            if (parsed?.version !== VERSION || typeof parsed.monitors !== 'object')
                return { monitors: {} };

            return { monitors: parsed.monitors ?? {} };
        } catch (e) {
            // Corrupt state must never take the extension down with it.
            console.warn(`dani-workspaces: discarding unreadable saved state: ${e}`);
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

    saveNow(registry) {
        const monitors = {};

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
        } catch (e) {
            console.warn(`dani-workspaces: could not save state: ${e}`);
        }
    }

    /** Flush any pending write and stop the timer. Call from disable(). */
    flush(registry) {
        if (!this._saveId)
            return;

        GLib.Source.remove(this._saveId);
        this._saveId = 0;
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
