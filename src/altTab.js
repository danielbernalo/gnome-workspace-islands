/**
 * Alt+Tab integration.
 *
 * Windows parked on an inactive virtual workspace are minimized, and GNOME
 * happily lists minimized windows. Left alone, Alt+Tab offers windows that
 * appear to be on this screen but belong to another arrangement.
 *
 * Two switchers, two different treatments — because only one of them can be
 * reached cleanly:
 *
 *   WindowSwitcherPopup   exported, with a `_getWindowList()` seam. Filtered
 *                         here: hidden windows simply aren't offered.
 *
 *   AppSwitcherPopup      exported, so `show()` is a seam — but the list it
 *                         shows comes from `AppSwitcher`, a module-private
 *                         `const` built inline in that popup's constructor.
 *                         Rather than reimplement that constructor, the items
 *                         it already built are re-ordered before the popup
 *                         appears.
 *
 * The app switcher is not filtered at all, and that is the behaviour this
 * extension wants: an outside un-minimize is treated as intent. Pick a window
 * from virtual workspace 2 by any means — app switcher, dash, a notification
 * — and that monitor switches to workspace 2 and takes you there. Filtering
 * hides the window and leaves the user wondering where it went; following
 * takes them to it.
 *
 * Its order is a different matter. `shell_app_compare` sorts an app whose
 * windows are all minimized behind every app that has a visible window, and
 * parking is minimizing — so the app you just left drops to the end of the
 * list the moment it is parked, and Alt+Tab stops returning to it. The
 * `alt-tab-mru-order` setting sorts the list by most recent use instead; see
 * reorderAppSwitcher().
 *
 * Uses InjectionManager rather than hand-rolled save/restore: it is the
 * supported seam for overriding shell methods and restores everything on
 * clear(), which is exactly the cleanup contract disable() has to honour.
 */

import Meta from 'gi://Meta';

import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';

import { isHiddenByUs } from './visibility.js';

let injector = null;
let extensionSettings = null;

/**
 * @param {object} opts
 * @param {Gio.Settings} opts.settings the extension's settings, read live so
 *   the preference takes effect without a session restart
 */
export function patch({ settings }) {
    extensionSettings = settings;

    injector = new InjectionManager();

    patchWindowSwitcher();
    patchAppSwitcher();
}

export function unpatch() {
    injector?.clear();
    injector = null;
    extensionSettings = null;
}

function patchWindowSwitcher() {
    const proto = AltTab.WindowSwitcherPopup?.prototype;

    // Never assume the seam is there. A shell update that renames or drops it
    // must degrade to "Alt+Tab is unfiltered", not to a broken extension.
    if (!proto || typeof proto._getWindowList !== 'function') {
        console.warn('workspace-islands: WindowSwitcherPopup._getWindowList not ' +
            'found — Alt+Tab will list windows from inactive workspaces');
        return;
    }

    injector.overrideMethod(proto, '_getWindowList', originalMethod => {
        return function (...args) {
            const windows = originalMethod.call(this, ...args);
            return windows.filter(window => !isHiddenByUs(window));
        };
    });
}

/**
 * Re-order the popup before it is shown.
 *
 * `show()` rather than `_init`: the popup is constructed and shown in the same
 * breath, and touching the items the constructor already built needs no access
 * to the module-private `AppSwitcher` at all.
 */
function patchAppSwitcher() {
    const proto = AltTab.AppSwitcherPopup?.prototype;

    if (!proto || typeof proto.show !== 'function') {
        console.warn('workspace-islands: AppSwitcherPopup.show not found — ' +
            'Alt+Tab will list apps from inactive workspaces behind visible ones');
        return;
    }

    injector.overrideMethod(proto, 'show', originalMethod => {
        return function (...args) {
            if (extensionSettings?.get_boolean('alt-tab-mru-order'))
                reorderAppSwitcher(this);

            return originalMethod.call(this, ...args);
        };
    });
}

/**
 * Sort the popup's apps by most recent use.
 *
 * GNOME's own order is `shell_app_compare`'s: an app with a visible window
 * comes before one whose windows are all minimized, and within each group the
 * most recently used comes first. Parking a window minimizes it, so that rule
 * moves a parked app behind everything still on screen the moment it is parked
 * — which is exactly the app Alt+Tab is supposed to return to.
 *
 * The sort is in place because the popup's `_items` and the switcher list's
 * own `_items` — the actors actually laid out — start as the same array. Both
 * have to move together, or the highlight would follow one order and the eye
 * the other.
 */
function reorderAppSwitcher(popup) {
    const switcherList = popup?._switcherList;
    const apps = popup?._items;
    const boxes = switcherList?._items;

    if (!apps || !boxes || apps.length !== boxes.length || apps.length < 2)
        return;

    const ranks = mruRanks();
    const items = apps.map((icon, index) => [icon, boxes[index]]);

    items.sort((a, b) => rankOf(a[0], ranks) - rankOf(b[0], ranks));

    for (let index = 0; index < items.length; index++) {
        const [icon, box] = items[index];

        apps[index] = icon;
        boxes[index] = box;
        switcherList._list.set_child_at_index(box, index);
    }
}

/** The app's windows, in MRU order, as the switcher cached them. */
function windowsOf(icon) {
    return icon.cachedWindows ?? [];
}

/**
 * Where each window sits in the switcher's own MRU list.
 *
 * Attached dialogs are ranked as their parent, exactly the way the switcher
 * folds them in when it builds its list, so a dialog cannot pull its app away
 * from where the main window sits.
 */
function mruRanks() {
    const ranks = new Map();
    let index = 0;

    for (const window of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)) {
        const parent = window.is_attached_dialog()
            ? window.get_transient_for()
            : window;

        if (parent && !ranks.has(parent))
            ranks.set(parent, index);

        index++;
    }

    return ranks;
}

function rankOf(icon, ranks) {
    let best = Infinity;

    for (const window of windowsOf(icon))
        best = Math.min(best, ranks.get(window) ?? Infinity);

    return best;
}
