// Parks windows by minimizing: hidden actors get re-shown by Mutter on native workspace switches.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Parked by us; Symbol.for so the tag survives a disable/enable re-import. */
const HIDDEN = Symbol.for('workspace-islands.hidden');

/** Already minimized when parked, so never un-minimized by us; set and cleared with HIDDEN. */
const USER_MINIMIZED = Symbol.for('workspace-islands.user-minimized');

// notify::minimized cannot tell our changes from the user's; listeners check this to avoid loops.
let applying = false;

export function isApplying() {
    return applying;
}

export function hide(window, { animate = true } = {}) {
    applying = true;
    try {
        // First park only: once parked, the window is minimized by us and would read as the user's.
        if (!window[HIDDEN]) {
            if (window.minimized)
                window[USER_MINIMIZED] = true;
            else
                delete window[USER_MINIMIZED];
        }

        if (!window.minimized) {
            if (!animate)
                skipEffect(window);

            window.minimize();
        }

        window[HIDDEN] = true;
    } finally {
        applying = false;
    }
}

export function show(window, { animate = true } = {}) {
    applying = true;
    try {
        if (window.minimized && minimizedByUs(window)) {
            if (!animate)
                skipEffect(window);

            window.unminimize();
        }

        delete window[HIDDEN];
        delete window[USER_MINIMIZED];
    } finally {
        applying = false;
    }
}

// Clones of minimized windows paint nothing; call only while something opaque covers the monitor.
export function reveal(window) {
    applying = true;
    try {
        if (window.minimized && minimizedByUs(window)) {
            skipEffect(window);
            window.unminimize();
        }
    } finally {
        applying = false;
    }
}

function skipEffect(window) {
    const actor = window.get_compositor_private();
    if (actor)
        Main.wm.skipNextEffect(actor);
}

export function forget(window) {
    delete window[HIDDEN];
    delete window[USER_MINIMIZED];
}

/** Parked on an inactive virtual workspace, whoever minimized it. */
export function isHiddenByUs(window) {
    return window[HIDDEN] === true;
}

function minimizedByUs(window) {
    return isHiddenByUs(window) && window[USER_MINIMIZED] !== true;
}
