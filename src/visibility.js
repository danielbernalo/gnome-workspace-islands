/**
 * Window visibility.
 *
 * Phase 0.b compared two ways of taking a window off its monitor without
 * moving it to another workspace:
 *
 *   actor-hide  hid the MetaWindowActor directly. Instant and animation-free,
 *               but a native workspace switch walks the actors and shows every
 *               window belonging to the incoming workspace. Our windows are
 *               sticky, so they belong to all of them — Mutter showed the lot
 *               and every virtual workspace landed on screen at once. Working
 *               around that meant re-hiding a frame later, on idle: a race
 *               against the shell, not a fix.
 *
 *   minimize    uses real window state. Mutter recomputes actor visibility on
 *               a workspace switch; it does not un-minimize windows. Nothing
 *               to reassert, no race. Focus handover comes free, because the
 *               window manager already knows a minimized window cannot hold
 *               focus.
 *
 * minimize won on the measurement that mattered: it survives native workspace
 * switches. The cost is a minimize animation and a minimized marker in the
 * dash, both of which were judged acceptable.
 *
 * The tag below is what makes teardown safe: only windows *we* minimized get
 * restored, so a window the user minimized by hand on some other virtual
 * workspace stays minimized. A window left hidden after the extension unloads
 * would be invisible and unreachable — that is the failure this guards.
 *
 * "Parked" and "minimized by us" are not the same thing, and conflating them
 * is how that promise was once broken. A window the user minimized and then
 * switched away from is parked like every other window on that workspace —
 * the Alt+Tab filter, the overview and the follow-an-outside-unminimize path
 * all need it to count as living elsewhere — but it was never ours to bring
 * back. So the tag is two marks: HIDDEN says "parked", and USER_MINIMIZED,
 * recorded the moment a window is first parked, says "and it was already
 * minimized when we got it". show() and reveal() only un-minimize a parked
 * window without the second mark, and leave every untagged minimized window
 * alone, which is what keeps a hand-minimized window minimized across a
 * switch round trip, the reapply() of an enable(), and disable().
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Marks a window as parked *by us*. Never touch windows without it. */
const HIDDEN = Symbol.for('workspace-islands.hidden');

/**
 * Marks a parked window that was already minimized when it was parked.
 *
 * Only ever set alongside HIDDEN and always cleared with it, so it can never
 * outlive the park it describes. `Symbol.for` for the same reason as HIDDEN:
 * a window parked before a disable/enable cycle must still be recognised.
 */
const USER_MINIMIZED = Symbol.for('workspace-islands.user-minimized');

/**
 * True while this module is driving a minimize/unminimize.
 *
 * Listeners on `notify::minimized` need to tell "the user did this" from "we
 * did this", and the signal gives them no way to know. Without this flag,
 * reacting to our own changes loops.
 */
let applying = false;

export function isApplying() {
    return applying;
}

/**
 * @param {Meta.Window} window
 * @param {object} [options]
 * @param {boolean} [options.animate] false while a slide is doing the visuals
 */
export function hide(window, { animate = true } = {}) {
    applying = true;
    try {
        // Recorded on the first park only. A window already parked has been
        // minimized by us since, and asking again would read our own doing
        // back as the user's.
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

/**
 * Un-park a window. Un-minimizes it only if we were the ones who minimized it:
 * an untagged minimized window (the user minimized it on the active
 * workspace) and a window parked while already minimized both stay as the
 * user left them.
 *
 * @param {object} [options] see {@link hide}
 */
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

/**
 * Put a window on screen for the duration of an animation, tag intact.
 *
 * A Clutter.Clone of a minimized window paints nothing, so a slide cannot show
 * where you are going until the incoming windows are really un-minimized. They
 * are still logically hidden while that happens — the tag stays, and whichever
 * page loses the slide is minimized again at the end.
 *
 * Only safe behind something opaque. Called with nothing covering the monitor,
 * this flashes every window of every prepared workspace onto the screen.
 *
 * A window the user minimized is not revealed. Its clone paints nothing, which
 * is what the screen will show once the slide lands, and the hide() that
 * re-parks the losing pages leaves it exactly as it found it.
 */
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

/**
 * Suppress the shell's minimize/unminimize effect for the next transition.
 *
 * Public API — `_shouldAnimateActor` consults the same set — so no injection is
 * needed to get an instant state change.
 */
function skipEffect(window) {
    const actor = window.get_compositor_private();
    if (actor)
        Main.wm.skipNextEffect(actor);
}

/** Drop the tag without touching the window. For windows that left our care. */
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
