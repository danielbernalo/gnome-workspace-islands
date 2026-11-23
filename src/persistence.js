import GLib from 'gi://GLib';

const STATE_KEY = 'saved-state';
const VERSION = 1;

const SAVE_DELAY_MS = 2000;

export class Persistence {
    constructor(settings) {
        this._settings = settings;
        this._saveId = 0;

        // Merge base for saveNow(): monitors not attached now survive only here.
        this._monitors = {};
    }

    load() {
        this._monitors = {};

        const raw = this._settings.get_string(STATE_KEY);
        if (!raw)
            return { monitors: {} };

        try {
            const parsed = JSON.parse(raw);
            if (parsed?.version !== VERSION || typeof parsed.monitors !== 'object')
                return { monitors: {} };

            // An array would be spread into keys "0", "1"... and written back as monitors.
            if (parsed.monitors && !Array.isArray(parsed.monitors))
                this._monitors = { ...parsed.monitors };

            return { monitors: parsed.monitors ?? {} };
        } catch (e) {
            console.warn(`workspace-islands: discarding unreadable saved state: ${e}`);
            return { monitors: {} };
        }
    }

    scheduleSave(registry) {
        if (this._saveId)
            GLib.Source.remove(this._saveId);

        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this.saveNow(registry);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Merged, not rebuilt: saved-state is the only home of monitors this enable() has not seen.
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

    // Unconditional: not every model change schedules a save, and a lock is a disable().
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

// Null, not '', so classless windows do not share one app rule.
export function appKeyOf(window) {
    const wmClass = window.get_wm_class();
    return wmClass ? wmClass.toLowerCase() : null;
}
