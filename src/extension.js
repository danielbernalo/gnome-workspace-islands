/**
 * Workspace Islands — independent per-monitor workspaces for GNOME Shell.
 *
 * Design in one paragraph: keep `workspaces-only-on-primary = true` so windows
 * on secondary monitors are sticky and untouched by native workspace switches,
 * then group those windows into virtual workspaces and control which group is
 * visible. No Clutter clones, no rendering pipeline changes, no tiling.
 *
 * See visibility.js for why hiding is done by minimizing.
 */

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Registry } from './monitorState.js';
import { Keybindings } from './keybindings.js';
import { Persistence } from './persistence.js';
import { Indicator } from './indicator.js';
import { SwitcherPopup } from './switcherPopup.js';
import { SlideController } from './slide.js';
import { isApplying, isHiddenByUs, forget } from './visibility.js';
import * as AltTabFilter from './altTab.js';
import * as OverviewFilter from './overview.js';

const MUTTER_SCHEMA = 'org.gnome.mutter';
const ONLY_ON_PRIMARY = 'workspaces-only-on-primary';
const PAPERWM_UUID = 'paperwm@paperwm.github.com';

export default class WorkspaceIslands extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._mutterSettings = new Gio.Settings({ schema_id: MUTTER_SCHEMA });

        this._persistence = new Persistence(this._settings);

        this._registry = new Registry(
            this._settings.get_int('virtual-workspaces'),
            this._persistence.load()
        );
        this._registry.syncMonitors();

        this._windowSignals = new Map();
        this._signals = [];
        this._keys = new Keybindings(this._settings);

        this._checkPreconditions();
        this._adoptExistingWindows();

        // Existing windows were adopted against the restored active index, so
        // bring the screen in line with it before anyone looks at it.
        for (const state of this._registry.states)
            state.reapply();

        this._connectSignals();
        this._bindKeys();

        // Takes over the panel's own workspace dots rather than adding a second
        // indicator beside them. See indicator.js.
        this._indicator = new Indicator({
            getFocusedState: () => this._registry?.forFocusedMonitor() ?? null,
        });

        // The panel only exists on the primary monitor. This one appears on the
        // monitor that actually changed.
        this._popup = new SwitcherPopup(this._settings);

        // Owns both the touchpad gesture and the slide. See slide.js for why
        // those are one thing and not two.
        this._slide = new SlideController({
            settings: this._settings,
            getState: index => this._registry?.forMonitorIndex(index) ?? null,
            onCommit: (state, index, { gesture }) =>
                this._commitSwitch(state, index, { announce: !gesture }),
            onProgress: (state, value) =>
                this._indicator?.setPreview(state, value),
        });

        AltTabFilter.patch();
        OverviewFilter.patch({
            getState: index => this._registry?.forMonitorIndex(index) ?? null,

            // The overview is already showing the result, so this commits
            // silently: no minimize animation to play under it, no OSD to
            // announce what the user just watched themselves choose.
            onActivate: (state, index) =>
                this._commitSwitch(state, index, { announce: false }),

            onDrop: (state, index, window, monitorIndex) =>
                this._dropWindow(state, index, window, monitorIndex),

            log: message => this._log(message),
        });

        // Unconditional, not behind debug-logging: when nothing appears to
        // happen, the first question is always whether this even loaded, and
        // "zero secondary monitors" is the single most likely answer.
        console.log(`workspace-islands: enabled — ` +
            `${this._registry.states.length} secondary monitor(s), ` +
            `${ONLY_ON_PRIMARY}=${this._mutterSettings.get_boolean(ONLY_ON_PRIMARY)}`);
    }

    disable() {
        AltTabFilter.unpatch();
        OverviewFilter.unpatch();

        // Flush before tearing anything down, or the last couple of seconds of
        // changes are lost on every logout.
        this._persistence?.flush(this._registry);
        this._persistence?.destroy();
        this._persistence = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._popup?.destroy();
        this._popup = null;

        // Before restoreAll(): an in-flight slide holds windows un-minimized
        // behind a cover, and tearing that down has to settle them first.
        this._slide?.destroy();
        this._slide = null;

        // Restoration is unconditional. A window left hidden after unload is
        // invisible and unreachable — nothing else here matters more.
        this._registry?.restoreAll();

        this._keys?.removeAll();
        this._keys = null;

        for (const [window, ids] of this._windowSignals ?? []) {
            for (const id of ids)
                window.disconnect(id);
        }
        this._windowSignals = null;

        for (const [object, id] of this._signals ?? [])
            object.disconnect(id);
        this._signals = null;

        this._registry?.clear();
        this._registry = null;
        this._mutterSettings = null;
        this._settings = null;
    }

    /**
     * The model only holds while secondary-monitor windows are sticky. If the
     * setting is off, or PaperWM is running (it forces the setting off — see
     * its patches.js), say so loudly instead of misbehaving quietly.
     */
    _checkPreconditions() {
        if (!this._mutterSettings.get_boolean(ONLY_ON_PRIMARY)) {
            Main.notifyError(
                'Workspace Islands',
                _('Requires %s = true. Secondary-monitor windows are not ' +
                'sticky without it.').format(`${MUTTER_SCHEMA}.${ONLY_ON_PRIMARY}`)
            );
        }

        if (this._isPaperwmEnabled()) {
            Main.notifyError(
                'Workspace Islands',
                _('PaperWM is enabled. Both extensions fight over %s with ' +
                'opposite values — disable one.').format(ONLY_ON_PRIMARY)
            );
        }
    }

    /**
     * Read the enabled list from gsettings rather than inspecting
     * ExtensionManager state, whose enum values are shell internals.
     */
    _isPaperwmEnabled() {
        try {
            const shell = new Gio.Settings({ schema_id: 'org.gnome.shell' });
            return shell.get_strv('enabled-extensions').includes(PAPERWM_UUID);
        } catch (e) {
            console.warn(`workspace-islands: could not read enabled extensions: ${e}`);
            return false;
        }
    }

    _adoptExistingWindows() {
        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;
            if (window)
                this._trackWindow(window);
        }
    }

    _connectSignals() {
        this._connect(global.display, 'window-created', (_d, window) => {
            this._trackWindow(window);
        });

        // A window dragged onto another monitor belongs to that monitor's
        // active virtual workspace from then on.
        this._connect(global.display, 'window-entered-monitor', (_d, _index, window) => {
            this._trackWindow(window);
        });

        this._connect(global.display, 'window-left-monitor', (_d, _index, window) => {
            this._registry.forWindow(window)?.untrack(window);
        });

        this._connect(Main.layoutManager, 'monitors-changed', () => {
            const live = this._registry.syncMonitors();

            // Unplugged monitors first: their windows are already on another
            // display and some are still minimized by us. Left alone they read
            // as lost windows.
            this._registry.pruneDetached(live);

            this._adoptExistingWindows();
            for (const state of this._registry.states)
                state.reapply();

            this._afterChange(`monitors changed — ${live.size} secondary`);
        });

        // The whole model collapses if this is flipped underneath us — and it
        // does get flipped: PaperWM forces it off, and it has been found off
        // for no traceable reason. Checking once at enable() is not enough.
        this._connect(this._mutterSettings, `changed::${ONLY_ON_PRIMARY}`, () => {
            if (this._mutterSettings.get_boolean(ONLY_ON_PRIMARY))
                return;

            Main.notifyError(
                'Workspace Islands',
                _('%s was turned off. Windows on secondary monitors are no ' +
                'longer sticky — virtual workspaces will leak.').format(ONLY_ON_PRIMARY)
            );
        });

        this._connect(this._settings, 'changed::virtual-workspaces', () => {
            this._registry.resize(this._settings.get_int('virtual-workspaces'));
            this._keys.removeAll();
            this._bindKeys();
            this._afterChange('workspace count changed');
        });
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _trackWindow(window) {
        const state = this._registry.forWindow(window);
        if (!state)
            return;

        state.track(window);
        this._indicator?.sync();

        if (this._windowSignals.has(window))
            return;

        const ids = [
            window.connect('unmanaged', () => {
                this._registry?.forWindow(window)?.untrack(window);
                this._disconnectWindow(window);
                this._indicator?.sync();
            }),
            window.connect('notify::minimized', () => {
                this._onMinimizedChanged(window);
            }),
        ];

        this._windowSignals.set(window, ids);
    }

    /**
     * Follow a window that something else brought back.
     *
     * The app switcher, the dash and notifications can all un-minimize a
     * window sitting on an inactive virtual workspace. Fighting that would
     * mean the window flickers and disappears again; instead the monitor
     * switches to wherever that window lives, which is what the user asked
     * for by picking it.
     */
    _onMinimizedChanged(window) {
        if (isApplying() || window.minimized || !isHiddenByUs(window))
            return;

        const state = this._registry?.forWindow(window);
        if (!state) {
            forget(window);
            return;
        }

        const index = state.indexOf(window);
        if (index < 0 || index === state.activeIndex) {
            forget(window);
            return;
        }

        this._log(`following un-minimize to virtual workspace ${index + 1} ` +
            `on ${state.connector}`);
        this._requestSwitch(state, index);
    }

    _disconnectWindow(window) {
        const ids = this._windowSignals?.get(window);
        if (!ids)
            return;

        for (const id of ids)
            window.disconnect(id);

        this._windowSignals.delete(window);
    }

    _bindKeys() {
        const count = this._settings.get_int('virtual-workspaces');

        // Only up to `count`: the remaining schema keys default to an empty
        // accelerator list, and registering those just logs noise.
        for (let i = 1; i <= count; i++)
            this._keys.add(`switch-to-${i}`, () => this._switchTo(i - 1));

        this._keys.add('switch-next', () => this._switchRelative(1));
        this._keys.add('switch-prev', () => this._switchRelative(-1));
        this._keys.add('move-window-to-next', () => this._moveFocused(1));
        this._keys.add('move-window-to-prev', () => this._moveFocused(-1));
    }

    /**
     * Acts on the monitor that has focus. On the primary monitor there is
     * nothing to do — GNOME's native workspaces already handle it — so the
     * shortcut is simply a no-op there rather than doing something surprising.
     */
    _switchTo(index, forward) {
        const state = this._registry.forFocusedMonitor();
        if (!state) {
            // Say so. A shortcut that quietly does nothing is undebuggable.
            this._log(`no-op: ${this._registry.describeFocusTarget()}`);
            return;
        }

        this._requestSwitch(state, index, forward);
    }

    /**
     * Switch, sliding if a slide is possible.
     *
     * The slide commits through onCommit when it lands, so there are two paths
     * to the same state change and only one of them is synchronous.
     *
     * @param {boolean} [forward] direction of travel, where one is meant; the
     *   shortcuts wrap, and a wrap has a direction its indices do not show
     */
    _requestSwitch(state, index, forward) {
        if (index < 0 || index >= state.size || index === state.activeIndex)
            return;

        if (this._slide?.animateSwitch(state, index, forward))
            return;

        this._commitSwitch(state, index, { slid: false });
    }

    /**
     * Apply the switch.
     *
     * @param {object} [options]
     * @param {boolean} [options.slid] a slide already showed this, so the
     *   minimize animation must not play on top of it
     * @param {boolean} [options.announce] show the on-screen popup
     *
     * The two are independent, which is not obvious and is worth stating.
     * GNOME shows the OSD on a *keyboard* switch even though the workspace also
     * slides (`_showWorkspaceSwitcher` runs the animation and then displays the
     * popup), and shows nothing on a swipe, where the movement under your
     * fingers is the feedback. Tying the popup to "did it slide" would silence
     * it for every shortcut.
     */
    _commitSwitch(state, index, { slid = true, announce = true } = {}) {
        if (!state.switchTo(index, { animate: !slid }))
            return;

        if (announce)
            this._popup?.show(state);

        this._afterChange(
            `${state.connector} -> virtual workspace ${index + 1} ` +
            `(${state.windowsOn(index).length} window(s))`);
    }

    /** Single place where a state change is persisted, shown and logged. */
    _afterChange(message) {
        this._persistence?.scheduleSave(this._registry);
        this._indicator?.sync();
        this._log(message);
    }

    _switchRelative(delta) {
        const state = this._registry.forFocusedMonitor();
        if (!state) {
            this._log(`no-op: ${this._registry.describeFocusTarget()}`);
            return;
        }

        const count = state.size;
        this._switchTo((state.activeIndex + delta + count) % count, delta > 0);
    }

    /**
     * Place a window dropped on a virtual workspace in the overview.
     *
     * Two cases. A window already on this monitor is just re-filed. A window
     * dragged in from another monitor has to be moved there first, and Mutter
     * announces that with `window-entered-monitor`, which adopts it onto
     * whatever the app rule or the active workspace says — so the reassignment
     * has to come after, not instead.
     */
    _dropWindow(state, index, window, monitorIndex) {
        if (window.get_monitor() !== monitorIndex)
            window.move_to_monitor(monitorIndex);

        if (state.indexOf(window) === -1)
            state.track(window, index);
        else
            state.moveWindowTo(window, index);

        this._afterChange(
            `dropped "${window.get_title()}" on virtual workspace ${index + 1} ` +
            `of ${state.connector}`);
    }

    _moveFocused(delta) {
        const window = global.display.focus_window;
        if (!window)
            return;

        const state = this._registry.forWindow(window);
        if (!state)
            return;

        const from = state.indexOf(window);
        if (from === -1)
            return;

        const to = (from + delta + state.size) % state.size;
        state.moveWindowTo(window, to);
        this._afterChange(
            `moved window to virtual workspace ${to + 1} on ${state.connector}`);
    }

    _log(message) {
        if (this._settings?.get_boolean('debug-logging'))
            console.log(`workspace-islands: ${message}`);
    }
}
