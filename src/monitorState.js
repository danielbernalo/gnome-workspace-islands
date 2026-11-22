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
import { isManageable } from './windowFilter.js';

/**
 * Every monitor keeps at least this many virtual workspaces, dynamic or not.
 *
 * Below 2, `overview.js` and `slide.js` fall back to treating the monitor as
 * having no virtual workspaces at all (plain overview, no swipe) — a floor of
 * 2 keeps that branch permanently unreachable instead of needing the monitor's
 * overview to swap view types live as it shrinks and grows.
 */
const MIN_SIZE = 2;

/**
 * Ceiling on the size a *restore* is allowed to ask for.
 *
 * Organic growth needs no limit and does not have one: `_growIfNeeded()` adds
 * a single workspace at a time, driven by a human opening a window. Restoring
 * is the opposite kind of event — it sizes a monitor straight from a JSON blob
 * in gsettings whose shape is validated no further than "is this an object",
 * so a corrupted or hand-edited value naming an enormous index would become an
 * enormous allocation inside `enable()`, taking the shell with it.
 *
 * Far above any arrangement a person would build, far below anything that
 * costs a frame to allocate. The point is that the number is bounded, not what
 * the bound is.
 */
const MAX_RESTORE_SIZE = 36;

export class MonitorState {
    /**
     * @param {string} connector
     * @param {boolean} [dynamic] grow/shrink with occupancy instead of
     *   staying at whatever count `Registry` applies externally
     */
    constructor(connector, dynamic = false) {
        this.connector = connector;
        this.activeIndex = 0;
        this._dynamic = dynamic;
        this._groups = Array.from({ length: MIN_SIZE }, () => new Set());
        this._appRules = new Map();

        // Restored rules whose app has not had a window here yet. They are
        // the ones an empty workspace can be reclaimed out from under — see
        // _reconcileEmpties().
        this._unconfirmedApps = new Set();

        // Restored rules that lost their workspace before their app opened a
        // window, in their saved order. Each means "a fresh workspace of its
        // own" — see indexForApp().
        this._pendingApps = new Set();

        this._sizeListeners = new Set();
    }

    setDynamic(dynamic) {
        this._dynamic = dynamic;
    }

    /**
     * Notified whenever `size` actually changes.
     *
     * @param {() => void} callback
     * @returns {() => void} unsubscribe
     */
    onSizeChanged(callback) {
        this._sizeListeners.add(callback);
        return () => this._sizeListeners.delete(callback);
    }

    _notifySizeChanged() {
        for (const listener of this._sizeListeners)
            listener();
    }

    /**
     * Plain object for serialisation: WM_CLASS -> virtual workspace index.
     *
     * Pending rules are written past the end, one index each in their saved
     * order. That is the shape that restores into the same thing: the next
     * restore() grows for them, the workspaces it grows are empty, and the
     * enable-time reconcile turns them back into pending rules. Writing them
     * at any index inside the arrangement would instead file the app on some
     * workspace another app's windows now occupy.
     */
    get appRules() {
        const rules = Object.fromEntries(this._appRules);

        let next = this.size;
        for (const key of this._pendingApps)
            rules[key] = next++;

        return rules;
    }

    /**
     * Restore a previously saved arrangement. Indices are clamped, not
     * trusted — `apps` and `activeIndex` come straight out of a JSON blob in
     * gsettings, and nothing about their shape is validated beyond "is this an
     * object".
     *
     * Which size they are clamped into depends on the mode, and the two arrive
     * here from opposite directions. A fixed-mode monitor was sized by
     * `Registry` before this ran and must stay at exactly that count, so this
     * only ever clamps. A dynamic one is born at {@link MIN_SIZE} and has
     * nobody to size it, so it grows to fit what it is about to restore —
     * within {@link MAX_RESTORE_SIZE}, which is what keeps a hostile number in
     * that blob from becoming a hostile allocation.
     */
    restore({ activeIndex = 0, apps = {} } = {}) {
        // Both come out of a JSON blob in gsettings, which anything can write.
        // A destructuring default only replaces `undefined`, so a `null` would
        // reach Object.entries() and throw, and clamp() passes NaN and
        // fractions straight through to be used as an array index. Either one
        // throws inside enable(), on every login and every unlock, because
        // the bad entry is never overwritten by a successful save.
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

    /**
     * Grow a dynamic monitor to fit the arrangement it is about to restore.
     *
     * `activeIndex` counts here, unlike everywhere else that treats it as a
     * mere hint about where somebody was looking. In dynamic mode the
     * workspace you are on is routinely empty — the trailing spare is empty by
     * definition, and sitting on it is how you get a fresh one — so declining
     * to grow for it is declining to restore it at all. Left out, every
     * teardown and rebuild of the extension drops you from wherever you were
     * onto workspace 2, and a lock screen is a teardown.
     *
     * Anything the growth cannot justify is collapsed straight back out by
     * `reconcileSize()` once `enable()` has adopted the real windows, so this
     * being generous costs a moment of oversized bookkeeping and nothing else.
     * The rules that pointed at those workspaces are not collapsed with them:
     * at login no app has a window yet, so every one of them is empty, and
     * dropping them would throw away every rule but the last.
     *
     * @param {number} activeIndex
     * @param {Object<string, number>} apps
     */
    _growForRestore(activeIndex, apps) {
        // reduce(), not Math.max(...spread): applying an array of unbounded
        // length as arguments is its own way to take the shell down, and the
        // length of this one is decided by whatever is in gsettings.
        const needed = [activeIndex, ...Object.values(apps)]
            .filter(Number.isInteger)
            .reduce((size, index) => Math.max(size, index + 1), MIN_SIZE);

        this.resize(Math.min(needed, MAX_RESTORE_SIZE));
    }

    /** Remember where this window's application belongs. */
    rememberApp(window, index) {
        const key = appKeyOf(window);
        if (!key)
            return;

        this._appRules.set(key, index);
        this._pendingApps.delete(key);
        this._unconfirmedApps.delete(key);
    }

    /**
     * A window of this app was just placed on `index`: its rule, if it was
     * restored, is no longer waiting for one. A pending rule takes the index
     * the window got, so the app's next window joins this one instead of
     * claiming a fresh workspace of its own again.
     */
    _confirmApp(window, index) {
        const key = appKeyOf(window);
        if (!key)
            return;

        this._unconfirmedApps.delete(key);
        if (this._pendingApps.delete(key))
            this._appRules.set(key, index);
    }

    /**
     * Saved workspace for this window's application, or -1 if unknown.
     *
     * A pending rule answers with the last workspace — the trailing spare in
     * dynamic mode. Its own workspace is gone, and the spare is the one that is
     * guaranteed to be fresh: once the window lands there, _growIfNeeded()
     * makes a new spare, so the next pending app gets a workspace of its own
     * too. In fixed mode that is the last workspace, which is where a rule
     * saved past the end would have been clamped anyway.
     */
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

    /** Where this exact window was on this monitor, or -1 if we have no note. */
    indexForPlacement(window) {
        const index = placementIndex(window, this.connector);

        // Clamped like indexForApp, and for a sharper reason: a note can
        // outlive a shrink of `virtual-workspaces`, because resize() can only
        // reach windows that are in a group at the time. In dynamic mode the
        // caller grows first — see _growForPlacement() — so this only bites
        // above MAX_RESTORE_SIZE.
        return index < 0 ? -1 : clamp(index, 0, this.size - 1);
    }

    /**
     * Make room for this window's note before it is read, in dynamic mode.
     *
     * A dynamic monitor is rebuilt at enable() sized only from what was
     * saved — the active index and the app rules — never from the notes,
     * and windows are adopted in stacking order, not workspace order. A note
     * naming workspace 3 read while the monitor has two would be clamped onto
     * workspace 2, and stamped there, merging two workspaces for good after
     * every lock. Fixed mode keeps the clamp: there, a note past the end is a
     * workspace the user removed, and folding is what a shrink means.
     *
     * Any gap this opens, for a window that closed while the extension was
     * away, is collapsed by the reconcileSize() that follows every adoption.
     */
    _growForPlacement(window) {
        if (!this._dynamic)
            return;

        const index = placementIndex(window, this.connector);
        if (index >= this.size)
            this.resize(Math.min(index + 1, MAX_RESTORE_SIZE));
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

        // Back in a group, so no longer owed a ride home. Clearing it here
        // rather than in the reclaim itself means a window is reclaimed at most
        // once per disconnect however it got back — under its own steam, by
        // Mutter, or by us.
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
     * A window the model cannot hold is refused here, not only by the caller:
     * every way into a group ends in this method, an overview drop included,
     * so this is the one check nothing can route around. See windowFilter.js.
     *
     * @returns {number} the index it was assigned to, or -1 if already
     *   tracked or refused
     */
    track(window, index = -1, { trustPlacement = true } = {}) {
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

    /**
     * @param {object} [options]
     * @param {boolean} [options.reconcile] collapse what this emptied. False
     *   for a caller that releases several windows in a row and reconciles
     *   once at the end: collapsing between them re-indexes the windows still
     *   here, and the notes of the ones already gone stay in the old frame.
     */
    untrack(window, { reconcile = true } = {}) {
        const from = this.indexOf(window);

        for (const group of this._groups)
            group.delete(window);

        if (from !== -1 && reconcile)
            this._reconcileEmpties();
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

        // The workspace just left may have been empty and is no longer
        // protected by being active — exactly what makes it removable now,
        // the same way native GNOME drops an empty workspace once you switch
        // away from it.
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

        // Moving a window by hand is the strongest signal we get about where
        // its application belongs, so it updates the rule.
        this.rememberApp(window, index);

        if (index === this.activeIndex)
            show(window);
        else
            hide(window);

        // The group it left behind, not the one it joined — that one just grew.
        this._reconcileEmpties();

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

        // Which windows this monitor lost, so the ones Mutter does not bring
        // back can be fetched when it returns. A WeakSet because it is only
        // ever asked "was this one yours" and never walked — a window closed
        // while the display is unplugged must not be kept alive by our
        // bookkeeping, and would be a dead reference by the time it came back.
        //
        // Added to, never replaced. pruneDetached() runs on every layout
        // change, and calls this again for a monitor that is still away — on
        // groups that are already empty. Replacing the set there would forget
        // every window the first unplug recorded, and a lid close or a resume
        // while undocked would be enough to lose the reclaim. Entries leave
        // only through _place(), when the window is back in a group.
        this._detached ??= new WeakSet();
        for (const window of this.allWindows)
            this._detached.add(window);

        this.restoreAll();

        for (const group of this._groups)
            group.clear();
    }

    /**
     * True if this monitor lost this window when it was unplugged.
     *
     * The difference between "belongs here" and "is owed a ride home". A window
     * the user moved to the laptop screen last week still carries a note naming
     * this monitor; it was not detached, and dragging it back is their call.
     */
    wasDetached(window) {
        return this._detached?.has(window) ?? false;
    }

    /** Resize the workspace count, folding anything beyond the new end. */
    resize(size) {
        if (size === this.size || size < MIN_SIZE)
            return;

        if (size > this.size) {
            while (this._groups.length < size)
                this._groups.push(new Set());
        } else {
            // Shrinking: everything past the new end collapses into the last
            // group rather than vanishing along with its windows.
            const tail = this._groups.splice(size);
            for (const group of tail) {
                for (const window of group)
                    this._place(window, size - 1);
            }

            if (this.activeIndex >= size)
                this.activeIndex = size - 1;

            // The fold can land parked windows on the workspace that is on
            // screen — the active one was the last, or was itself folded and
            // clamped onto it — and nothing else would show them until the
            // user switched away and back. Only what we parked: a window the
            // user minimized stays minimized, which show() already honours.
            // Nothing needs hiding: a fold into an inactive workspace only
            // ever carries windows that were already parked.
            if (this.activeIndex === size - 1) {
                for (const window of this.windowsOn(size - 1)) {
                    if (isHiddenByUs(window))
                        show(window, { animate: false });
                }
            }

            // Rules pointing past the new end would silently send windows nowhere.
            for (const [key, index] of this._appRules) {
                if (index >= size)
                    this._appRules.set(key, size - 1);
            }
        }

        this._notifySizeChanged();
    }

    /**
     * Grow by one if the group a window just landed in was the last one.
     *
     * Only in dynamic mode, and with no ceiling — the same shape as GNOME's
     * own dynamic workspaces always keeping one empty one in reserve.
     */
    _growIfNeeded(index) {
        if (this._dynamic && index === this.size - 1)
            this.resize(this.size + 1);
    }

    /**
     * Remove every empty group except the active one and the last one,
     * shifting later indices down to fill the gap.
     *
     * Only in dynamic mode. Matches native GNOME dynamic workspaces: an empty
     * workspace disappears unless it's the one you're looking at (removing
     * that out from under you would be jarring) or the trailing spare (always
     * kept in reserve). A no-op if nothing qualifies, so it is cheap to call
     * after anything that might have emptied a group.
     */
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

        // Never below the floor, even if that means leaving some empty
        // slots in place — see MIN_SIZE.
        const toRemove = new Set(removable.slice(0, Math.max(0, this.size - MIN_SIZE)));
        if (toRemove.size === 0)
            return;

        // Re-stamp windows whose index changed as each slot is kept, so a
        // future reclaim/restore agrees with where they actually ended up —
        // _place() is the only other writer of this note, and it isn't
        // involved in a pure re-index.
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

        // A rule pointing at a slot that just got removed for being empty
        // loses its home — dropped, the same way a stale rule a shrink can't
        // reach is already dropped today, rather than remapped to somewhere
        // it never asked for.
        //
        // Except a restored rule whose app has not opened a window yet. Its
        // workspace was not emptied by anybody; it was empty because nothing
        // had started, and at login that is every rule there is. Those become
        // pending instead — see indexForApp(). So does one left pointing at
        // the empty trailing spare: pending rules resolve to that same spare,
        // and two apps both claiming it would end up sharing a workspace.
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

    /**
     * Re-establish the dynamic-mode empty-workspace invariant after something
     * that changes membership without going through
     * track()/untrack()/moveWindowTo()/switchTo() — a restore that grew to
     * fit saved data, or a hotplug that reclaimed some windows but not
     * others. Safe to call unconditionally; a no-op outside dynamic mode or
     * when the invariant already holds.
     */
    reconcileSize() {
        this._reconcileEmpties();

        // An empty active workspace directly before the empty last one is the
        // spare already; the last is a second one. _reconcileEmpties() keeps
        // both, which is right at runtime — that is the shape you are left in
        // when the window you were looking at closes — but here it is an
        // artefact of saving while sitting on the spare: appRules writes
        // pending rules past `size`, restore() grows past the active index
        // for them, and the active and the last survive the collapse as two
        // empties. Left there, the arrangement grows by one at every unlock,
        // and the next pending app resolves to the last workspace instead of
        // the one on screen and opens hidden. Dropping the last, which is
        // empty so nothing folds, makes the round trip restore what was saved.
        const last = this.size - 1;
        if (this._dynamic && this.activeIndex === last - 1 &&
            this._groups[last].size === 0 && this._groups[last - 1].size === 0)
            this.resize(last);

        // The other half of the invariant. _reconcileEmpties() only ever
        // removes, and every path that fills the last workspace grows a spare
        // as it does — except the ones that arrive here: switching from fixed
        // mode with the last workspace occupied, or a restore whose windows
        // filled it without going through track().
        if (this._dynamic && this._groups[this.size - 1].size > 0)
            this.resize(this.size + 1);
    }
}

export class Registry {
    /**
     * @param {number} fixedCount the exact count applied when not dynamic;
     *   has no effect on a monitor currently in dynamic mode, which grows
     *   without a ceiling
     * @param {boolean} dynamic
     * @param {object} [saved]
     */
    constructor(fixedCount, dynamic, saved = { monitors: {} }) {
        this._fixedCount = fixedCount;
        this._dynamic = dynamic;
        this._states = new Map();

        // The monitor whose workspace was just switched to an empty one. See
        // holdFocus().
        this._heldFocus = null;

        // Kept around rather than applied once: a monitor plugged in later in
        // the session must get its saved arrangement too, not a default one.
        this._saved = saved;
    }

    _createState(connector) {
        const state = new MonitorState(connector, this._dynamic);

        // Fixed mode: size to the configured count *before* restoring, not
        // after — restore() clamps a fixed-mode monitor rather than growing
        // it, so a saved rule within that count has to find the real size
        // already in place or it clamps down to the floor and stays there.
        //
        // Dynamic mode is deliberately not sized here. It has no configured
        // count to be sized *to*, and the number it actually needs is a
        // property of the saved arrangement, which restore() is the one
        // holding. From there on size is earned by occupancy.
        if (!this._dynamic)
            state.resize(this._fixedCount);

        // A saved arrangement is a convenience; a monitor is not. If restoring
        // ever throws, start this monitor fresh rather than let enable() fail
        // on every login over a blob a successful save would have replaced.
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

    /**
     * Change the static-mode count.
     *
     * Applied immediately only to monitors currently in fixed mode. A
     * dynamic monitor has no ceiling to change — the new value is just
     * remembered for whenever fixed mode resumes on it.
     */
    setFixedCount(count) {
        this._fixedCount = count;
        if (this._dynamic)
            return;

        for (const state of this._states.values())
            state.resize(count);
    }

    /**
     * Switch every monitor between fixed and dynamic.
     *
     * Fixed -> dynamic: trims empty workspaces the way dynamic mode would
     * have, and adds the empty spare if the last workspace is occupied.
     * Growth resumes organically from there.
     * Dynamic -> fixed: forces every monitor to the exact configured count,
     * identical to a plain count change today.
     */
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

    /**
     * Drop every window that sits on a different monitor from the one whose
     * group holds it.
     *
     * For the end of a layout change, which is the one time this happens
     * without the window telling us. While the layout moves, the per-window
     * monitor signals are ignored — see the extension's window-left-monitor
     * handler — so a window Mutter put somewhere else is still filed where it
     * was. Bookkeeping only, and without collapsing anything: what is left
     * gets adopted, reapplied and reconciled by the settle right after, and a
     * window that is now on no secondary at all is shown by
     * {@link restoreOrphans}.
     */
    releaseStrays() {
        for (const state of this._states.values()) {
            for (const window of state.allWindows) {
                if (this.forWindow(window) !== state)
                    state.untrack(window, { reconcile: false });
            }
        }
    }

    /**
     * Show every window we parked that no workspace holds any more.
     *
     * The tag lives on the window, the groups live here, and a few paths can
     * separate them — a monitor change moving a parked window to the primary,
     * a slide settling a window that left its group. Such a window is
     * minimized with nothing on screen to explain it, and nothing but this
     * would ever bring it back.
     *
     * @param {Iterable<Meta.Window>} windows every window the shell has
     */
    restoreOrphans(windows) {
        for (const window of windows) {
            if (isHiddenByUs(window) && !this.states.some(state => state.indexOf(window) !== -1))
                show(window, { animate: false });
        }
    }

    /**
     * Keep the keyboard on a monitor that has nothing left to focus.
     *
     * Switching a monitor to an empty workspace parks the focused window, and
     * Mutter then hands focus to whatever is on top elsewhere — the primary.
     * The extension unsets focus instead, and this is what makes the next
     * shortcut still land here: {@link forFocusedMonitor} would otherwise fall
     * back to the pointer, and a hand on the keyboard says nothing about
     * where the pointer is. Only consulted while nothing has focus.
     *
     * @param {string|null} connector
     */
    holdFocus(connector) {
        this._heldFocus = connector;
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
        if (this._heldFocus && !global.display.focus_window)
            return this.forConnector(this._heldFocus);

        const index = focusedMonitorIndex();
        if (index < 0 || index === Main.layoutManager.primaryIndex)
            return null;

        if (!Main.layoutManager.monitors[index])
            return null;

        return this.forConnector(connectorOf(index));
    }

    /**
     * State for the monitor under the pointer, or null if that's primary.
     *
     * The deliberate opposite of {@link forFocusedMonitor}, and for the reason
     * stated there in reverse: a shortcut is pressed with a hand on the
     * keyboard, so the focused window decides. A wheel is turned with a hand on
     * the mouse, so the pointer decides. Asking the focused window where a
     * wheel notch belongs would scroll a screen the user is not pointing at.
     */
    forPointerMonitor() {
        return this.forMonitorIndex(global.display.get_current_monitor());
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

        if (this._heldFocus && !live.has(this._heldFocus))
            this._heldFocus = null;
    }

    /**
     * Put every window we parked back on screen. Must be total — see
     * visibility.js.
     *
     * The groups are not enough on their own: a window can carry our tag
     * while no group holds it (see {@link restoreOrphans}), and after an
     * unload nothing would ever show it again.
     *
     * @param {Iterable<Meta.Window>} [windows] every window the shell has
     */
    restoreAll(windows = []) {
        for (const state of this._states.values())
            state.restoreAll();

        this.restoreOrphans(windows);
    }

    clear() {
        this._states.clear();
    }
}

/**
 * Index -> connector for the current layout, or null when it needs rereading.
 *
 * Cached because this is not a cold path: the indicator resolves the focused
 * monitor on every frame of a swipe preview, and asking the backend to name
 * every output sixty times a second to answer a question whose answer cannot
 * change mid-gesture is work for nothing. {@link invalidateConnectors} is the
 * other half — the layout is the only thing that can make this stale.
 */
let connectors = null;

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
    connectors ??= readConnectors();
    return connectors[index] ?? `monitor-${index}`;
}

/** Drop the cache. Call whenever the monitor layout is about to change. */
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
        // A backend that cannot name its monitors is not a reason to stop
        // working. Positional keys are what this did before, and they are right
        // for as long as nothing is unplugged.
        console.warn(`workspace-islands: could not read monitor connectors: ${e}`);
    }

    return map;
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
