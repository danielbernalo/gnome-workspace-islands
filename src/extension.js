// Groups sticky secondary-monitor windows (workspaces-only-on-primary) into virtual workspaces.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Registry, invalidateConnectors, monitorIndexOf } from './monitorState.js';
import { placementConnector } from './placement.js';
import { Keybindings } from './keybindings.js';
import { Persistence } from './persistence.js';
import { Indicator } from './indicator.js';
import { SwitcherPopup } from './switcherPopup.js';
import { SlideController } from './slide.js';
import { isApplying, isHiddenByUs, forget } from './visibility.js';
import { isManageable } from './windowFilter.js';
import * as AltTabFilter from './altTab.js';
import * as OverviewFilter from './overview.js';
import * as ScrollFilter from './scroll.js';

const MUTTER_SCHEMA = 'org.gnome.mutter';
const ONLY_ON_PRIMARY = 'workspaces-only-on-primary';
const PAPERWM_UUID = 'paperwm@paperwm.github.com';

// The schema defines only switch-to-1..8; dynamic mode has no smaller count to bind up to.
const MAX_DIRECT_SWITCH_KEYS = 8;

// Debounce for monitors-changed bursts, which report bogus interim layouts across loop iterations.
const SETTLE_DELAY_MS = 300;

export default class WorkspaceIslands extends Extension {
    enable() {
        // The module outlives disable(), and its connector cache goes stale while displays change.
        invalidateConnectors();

        this._settings = this.getSettings();
        this._mutterSettings = new Gio.Settings({ schema_id: MUTTER_SCHEMA });

        this._persistence = new Persistence(this._settings);

        this._registry = new Registry(
            this._settings.get_int('virtual-workspaces'),
            this._settings.get_boolean('dynamic-virtual-workspaces'),
            this._persistence.load()
        );
        this._registry.syncMonitors();

        this._windowSignals = new Map();
        this._signals = [];
        this._settleId = 0;
        this._layoutChanging = false;
        this._keys = new Keybindings(this._settings);

        this._checkPreconditions();
        this._adoptExistingWindows();

        // Restored state may hold trailing empty workspaces that dynamic mode never got to trim.
        for (const state of this._registry.states) {
            state.reapply();
            state.reconcileSize();
        }

        this._connectSignals();
        this._bindKeys();

        this._indicator = new Indicator({
            getFocusedState: () => this._registry?.forFocusedMonitor() ?? null,
        });

        this._popup = new SwitcherPopup(this._settings);

        this._slide = new SlideController({
            settings: this._settings,
            getState: index => this._registry?.forMonitorIndex(index) ?? null,
            onCommit: (state, index, { gesture }) =>
                this._commitSwitch(state, index, { announce: !gesture }),
            onProgress: (state, value) =>
                this._indicator?.setPreview(state, value),
        });

        AltTabFilter.patch();

        ScrollFilter.patch({
            getState: () => this._registry?.forPointerMonitor() ?? null,

            onScroll: (state, index, forward) =>
                this._requestSwitch(state, index, forward),

            log: message => this._log(message),
        });

        OverviewFilter.patch({
            getState: index => this._registry?.forMonitorIndex(index) ?? null,

            onActivate: (state, index) =>
                this._commitSwitch(state, index, { announce: false }),

            onDrop: (state, index, window, monitorIndex) =>
                this._dropWindow(state, index, window, monitorIndex),

            log: message => this._log(message),
        });

        // Deliberately not behind debug-logging: whether it loaded is the first thing to check.
        console.log(`workspace-islands: enabled — ` +
            `${this._registry.states.length} secondary monitor(s), ` +
            `${ONLY_ON_PRIMARY}=${this._mutterSettings.get_boolean(ONLY_ON_PRIMARY)}`);
    }

    disable() {
        AltTabFilter.unpatch();
        ScrollFilter.unpatch();
        OverviewFilter.unpatch();

        // Before the registry goes, so a settle never fires into a half-dismantled extension.
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = 0;
        }

        // Flush before tearing anything down, or the last pending changes are lost on logout.
        this._persistence?.flush(this._registry);
        this._persistence?.destroy();
        this._persistence = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._popup?.destroy();
        this._popup = null;

        // Before restoreAll(): an in-flight slide holds windows un-minimized behind a cover.
        this._slide?.destroy();
        this._slide = null;

        // Every shell window, not only tracked ones: the hidden tag can outlive the membership.
        this._registry?.restoreAll(this._shellWindows());

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

    _checkPreconditions() {
        // Locking re-runs enable() once per extension rebase; notifying then queues duplicate errors.
        if (Main.sessionMode.isLocked)
            return;

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
        for (const window of this._shellWindows())
            this._trackWindow(window);
    }

    _shellWindows() {
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(Boolean);
    }

    _connectSignals() {
        this._connect(global.display, 'window-created', (_d, window) => {
            this._trackWindow(window);
        });

        this._connect(global.display, 'window-entered-monitor', (_d, _index, window) => {
            this._onWindowEnteredMonitor(window);
        });

        this._connect(global.display, 'window-left-monitor', (_d, _index, window) => {
            this._onWindowLeftMonitor(window);
        });

        // Raise the flag at the earliest hint: Mutter moves windows before monitors-changed re-emits.
        this._connect(global.backend.get_monitor_manager(), 'monitors-changing', () => {
            invalidateConnectors();
            this._layoutChanging = true;
            // Settle here too, or an announced then abandoned layout leaves the flag raised forever.
            this._scheduleSettle();
        });

        this._connect(Main.layoutManager, 'monitors-changed', () => {
            invalidateConnectors();

            // Raised here too: the settle moves windows itself and the handlers must see a relocation.
            this._layoutChanging = true;

            // First: a slide is pinned to a monitor index and holds windows un-minimized behind a cover.
            this._slide?.cancel();

            const live = this._registry.syncMonitors();

            // Now, not after settling: unplugged monitors' windows may still be minimized by us.
            this._registry.pruneDetached(live);

            this._scheduleSettle();
        });

        // PaperWM and others flip this at runtime, so checking once at enable() is not enough.
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
            this._registry.setFixedCount(this._settings.get_int('virtual-workspaces'));
            this._keys.removeAll();
            this._bindKeys();
            this._afterChange('workspace count changed');
        });

        this._connect(this._settings, 'changed::dynamic-virtual-workspaces', () => {
            this._registry.setDynamic(this._settings.get_boolean('dynamic-virtual-workspaces'));

            // _bindKeys() reads this setting to choose how many switch-to-N keys to register.
            this._keys.removeAll();
            this._bindKeys();
            this._afterChange('dynamic workspaces toggled');
        });

        // _bindKeys() skips unset switch-to-N keys, so one assigned while running must be bound now.
        for (let i = 1; i <= MAX_DIRECT_SWITCH_KEYS; i++) {
            this._connect(this._settings, `changed::switch-to-${i}`, () => {
                this._keys.removeAll();
                this._bindKeys();
            });
        }

        // Anything taking focus ends the hold _focusActive() sets for an empty workspace.
        this._connect(global.display, 'notify::focus-window', () => {
            if (global.display.focus_window)
                this._registry?.holdFocus(null);
        });
    }

    _onWindowEnteredMonitor(window) {
        // Mid layout change this is Mutter relocating against a stale layout; the settle files it.
        if (this._layoutSettling)
            return;

        this._trackWindow(window, { trustPlacement: false });
    }

    _onWindowLeftMonitor(window) {
        // Untracking one by one mid layout change re-indexes workspaces and loses the arrangement.
        if (this._layoutSettling)
            return;

        // By the note: get_monitor() already names the monitor the window arrived at.
        const connector = placementConnector(window);
        if (connector)
            this._registry.forConnector(connector)?.untrack(window);

        this._indicator?.sync();
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    // Separates Mutter relocating windows from a user drag, which must not honour placement notes.
    get _layoutSettling() {
        return this._layoutChanging || this._settleId !== 0;
    }

    _scheduleSettle() {
        if (this._settleId)
            GLib.Source.remove(this._settleId);

        this._settleId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SETTLE_DELAY_MS, () => {
                this._settleId = 0;
                this._settleLayout();
                return GLib.SOURCE_REMOVE;
            });

        GLib.Source.set_name_by_id(this._settleId, '[workspace-islands] monitor settle');
    }

    // Idempotent: track() reads notes first, so running on a still-moving layout only repeats work.
    _settleLayout() {
        if (!this._registry)
            return;

        const live = this._registry.syncMonitors();

        // Reclaim before adopting, or windows get filed on the monitor they have not returned to yet.
        let reclaimed = 0;
        for (const connector of live)
            reclaimed += this._reclaim(connector);

        // Release windows moved while the handlers stood aside, so adoption files each exactly once.
        this._registry.releaseStrays();
        this._adoptExistingWindows();

        // Live monitors only: reconciling a detached one would collapse the arrangement kept for it.
        for (const state of this._registry.states) {
            if (!live.has(state.connector))
                continue;

            state.reapply();
            state.reconcileSize();
        }

        this._registry.restoreOrphans(this._shellWindows());

        // Last: the reclaim above goes through handlers that read this flag to tell relocation from drag.
        this._layoutChanging = false;

        this._afterChange(
            `monitors settled — ${live.size} secondary` +
            (reclaimed ? `, ${reclaimed} window(s) reclaimed` : ''));
    }

    // Only windows this monitor lost on detach, and only on its return; Mutter usually beats us to it.
    _reclaim(connector) {
        const state = this._registry.forConnector(connector);
        const monitorIndex = monitorIndexOf(connector);
        if (!state || monitorIndex < 0)
            return 0;

        let moved = 0;

        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;

            if (!window || !state.wasDetached(window))
                continue;

            if (window.get_monitor() === monitorIndex)
                continue;

            this._log(`reclaiming "${window.get_title()}" onto ${connector}`);
            window.move_to_monitor(monitorIndex);
            moved++;
        }

        return moved;
    }

    _trackWindow(window, { trustPlacement = true, index = -1, state = null } = {}) {
        if (!isManageable(window))
            return;

        state ??= this._registry.forWindow(window);
        if (!state)
            return;

        state.track(window, index, { trustPlacement });
        this._indicator?.sync();

        if (this._windowSignals.has(window))
            return;

        const ids = [
            window.connect('unmanaged', () => {
                // Everywhere: an unmanaged window has no meaningful monitor, and a stale entry gets minimized.
                this._registry?.untrackEverywhere(window);
                this._disconnectWindow(window);
                this._indicator?.sync();
            }),
            window.connect('notify::minimized', () => {
                this._onMinimizedChanged(window);
            }),
        ];

        this._windowSignals.set(window, ids);
    }

    // Outside un-minimizes (app switcher, dash, notifications) are followed, not fought.
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
        const count = this._settings.get_boolean('dynamic-virtual-workspaces')
            ? MAX_DIRECT_SWITCH_KEYS
            : this._settings.get_int('virtual-workspaces');

        for (let i = 1; i <= count; i++) {
            const name = `switch-to-${i}`;
            if (this._settings.get_strv(name).length > 0)
                this._keys.add(name, () => this._switchTo(i - 1));
        }

        this._keys.add('switch-next', () => this._switchRelative(1));
        this._keys.add('switch-prev', () => this._switchRelative(-1));
        this._keys.add('move-window-to-next', () => this._moveFocused(1));
        this._keys.add('move-window-to-prev', () => this._moveFocused(-1));
    }

    _switchTo(index, forward) {
        const state = this._registry.forFocusedMonitor();
        if (!state) {
            this._log(`no-op: ${this._registry.describeFocusTarget()}`);
            return;
        }

        this._requestSwitch(state, index, forward);
    }

    _requestSwitch(state, index, forward) {
        if (index < 0 || index >= state.size || index === state.activeIndex)
            return;

        if (this._slide?.animateSwitch(state, index, forward))
            return;

        this._commitSwitch(state, index, { slid: false });
    }

    // slid and announce are independent: GNOME shows the OSD on keyboard switches that also slide.
    _commitSwitch(state, index, { slid = true, announce = true } = {}) {
        // Read before switching: afterwards the focused window is the one just parked.
        const focus = global.display.focus_window;
        const ownsFocus = !focus || this._registry.forWindow(focus) === state;

        if (!state.switchTo(index, { animate: !slid }))
            return;

        if (ownsFocus)
            this._focusActive(state);

        if (announce)
            this._popup?.show(state);

        // activeIndex, not index: switchTo() may have collapsed an empty workspace and shifted indices.
        this._afterChange(
            `${state.connector} -> virtual workspace ${state.activeIndex + 1} ` +
            `(${state.activeWindows.length} window(s))`);
    }

    // Beat Mutter's focus handover, which would send focus to the primary since all windows are sticky.
    _focusActive(state) {
        const current = global.display.focus_window;
        if (current && !current.minimized && state.indexOf(current) === state.activeIndex)
            return;

        const shown = state.activeWindows.filter(window => !window.minimized);
        const top = global.display.sort_windows_by_stacking(shown).at(-1);
        if (top) {
            top.activate(global.get_current_time());
            return;
        }

        global.display.unset_input_focus(global.get_current_time());
        this._registry.holdFocus(state.connector);
    }

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

    _dropWindow(state, index, window, monitorIndex) {
        if (!isManageable(window)) {
            this._log(`drop declined: "${window.get_title()}" is not a window ` +
                'virtual workspaces can hold');
            return;
        }

        // Move first: window-entered-monitor adopts it, so the reassignment below must come after.
        if (window.get_monitor() !== monitorIndex)
            window.move_to_monitor(monitorIndex);

        // _trackWindow(), not track(), so a first-time window also gets its signal handlers.
        if (state.indexOf(window) === -1)
            this._trackWindow(window, { index, state });
        else
            state.moveWindowTo(window, index);

        this._afterChange(
            `dropped "${window.get_title()}" on virtual workspace ${index + 1} ` +
            `of ${state.connector}`);
    }

    _moveFocused(delta) {
        const window = global.display.focus_window;
        if (!window) {
            this._log('no-op: no focused window');
            return;
        }

        const state = this._registry.forWindow(window);
        if (!state) {
            this._log(`no-op: ${this._registry.describeFocusTarget()}`);
            return;
        }

        const from = state.indexOf(window);
        if (from === -1) {
            this._log(`no-op: "${window.get_title()}" is not tracked on ${state.connector}`);
            return;
        }

        const wasOnScreen = from === state.activeIndex;
        const to = (from + delta + state.size) % state.size;
        state.moveWindowTo(window, to);

        if (wasOnScreen)
            this._focusActive(state);
        this._afterChange(
            `moved window to virtual workspace ${to + 1} on ${state.connector}`);
    }

    _log(message) {
        if (this._settings?.get_boolean('debug-logging'))
            console.log(`workspace-islands: ${message}`);
    }
}
