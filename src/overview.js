/**
 * Overview integration.
 *
 * The overview shows every window on a workspace, minimized ones included. Our
 * parked windows are minimized, so without this the overview displays all
 * virtual workspaces at once — the same leak Alt+Tab had, in the one place
 * users go specifically to see what is open.
 *
 * `Workspace._isOverviewWindow` is the seam, and it is a good one: exported
 * class, single-purpose predicate, called for each window before a preview is
 * built. Overriding it makes the overview agree with the screen.
 *
 * Scope note. "Overview integration" could also mean putting a virtual
 * workspace selector inside the overview, next to the native workspace strip.
 * That is deliberately not done here. It would mean reaching into the
 * workspace-thumbnails layout — internals with no contract, the part of this
 * project most likely to break on a GNOME update — to duplicate navigation the
 * panel indicator and keyboard shortcuts already provide. Filtering is the
 * part that fixes a real inconsistency; the selector would be a second way to
 * do something you can already do, bought at the highest maintenance price in
 * the codebase.
 */

import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Workspace } from 'resource:///org/gnome/shell/ui/workspace.js';

import { isHiddenByUs } from './visibility.js';

let injector = null;

export function patch() {
    const proto = Workspace?.prototype;

    // Degrade to "the overview shows everything", never to a broken shell.
    if (!proto || typeof proto._isOverviewWindow !== 'function') {
        console.warn('dani-workspaces: Workspace._isOverviewWindow not found — ' +
            'the overview will show windows from inactive workspaces');
        return;
    }

    injector = new InjectionManager();
    injector.overrideMethod(proto, '_isOverviewWindow', originalMethod => {
        return function (window) {
            if (isHiddenByUs(window))
                return false;

            return originalMethod.call(this, window);
        };
    });
}

export function unpatch() {
    injector?.clear();
    injector = null;
}
