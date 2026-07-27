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
 *   AppSwitcher           module-private `const`, built inline inside
 *                         AppSwitcherPopup._init. Patching it would mean
 *                         reimplementing that constructor against internals
 *                         with no stable contract.
 *
 * So the app switcher is not filtered at all. Instead, the extension treats an
 * outside un-minimize as intent: pick a window from virtual workspace 2 by any
 * means — app switcher, dash, a notification — and that monitor switches to
 * workspace 2 and takes you there.
 *
 * That is the better behaviour anyway. Filtering hides the window and leaves
 * the user wondering where it went; following takes them to it. The fragile
 * patch would have bought a worse experience.
 *
 * Uses InjectionManager rather than hand-rolled save/restore: it is the
 * supported seam for overriding shell methods and restores everything on
 * clear(), which is exactly the cleanup contract disable() has to honour.
 */

import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';

import { isHiddenByUs } from './visibility.js';

let injector = null;

export function patch() {
    const proto = AltTab.WindowSwitcherPopup?.prototype;

    // Never assume the seam is there. A shell update that renames or drops it
    // must degrade to "Alt+Tab is unfiltered", not to a broken extension.
    if (!proto || typeof proto._getWindowList !== 'function') {
        console.warn('workspace-islands: WindowSwitcherPopup._getWindowList not ' +
            'found — Alt+Tab will list windows from inactive workspaces');
        return;
    }

    injector = new InjectionManager();
    injector.overrideMethod(proto, '_getWindowList', originalMethod => {
        return function (...args) {
            const windows = originalMethod.call(this, ...args);
            return windows.filter(window => !isHiddenByUs(window));
        };
    });
}

export function unpatch() {
    injector?.clear();
    injector = null;
}
