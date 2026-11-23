// AppSwitcher is module-private and left unfiltered; outside un-minimizes are followed instead.

import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';

import { isHiddenByUs } from './visibility.js';

let injector = null;

export function patch() {
    const proto = AltTab.WindowSwitcherPopup?.prototype;

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
