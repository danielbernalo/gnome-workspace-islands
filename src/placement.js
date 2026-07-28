/**
 * Where a window was, for as long as the window lives.
 *
 * persistence.js opens by stating a hard limit: windows have no stable identity
 * *across sessions*. That is true, and it is also the wrong limit to plan
 * around, because almost nothing that loses an arrangement is a new session. A
 * lock screen disables the extension and re-enables it four minutes later. A
 * suspend takes every monitor down and brings it back. A dock is unplugged over
 * lunch. In all of those the shell process never died and the MetaWindow
 * objects are the same objects — the mapping was recoverable the whole time,
 * and it was being thrown away and then guessed back from WM_CLASS, which is
 * how four workspaces of one browser come back as one.
 *
 * So each window carries a note: the connector it was on and the virtual
 * workspace it was on there, written onto the MetaWindow's JS wrapper under a
 * namespaced symbol. visibility.js already does exactly this with its HIDDEN
 * tag, for exactly the same reason — the note has to outlive the extension
 * object, and the window is the only thing in reach that does.
 *
 * `Symbol.for`, not `Symbol()`. The global registry is what makes the key the
 * same key after a disable/enable cycle; a private symbol would be a fresh,
 * unrelated key on every re-import and every note left by the previous life
 * would be invisible. (workspacesView.js uses a private symbol for its page
 * tags, and that is right there — those never outlive the view that made them.)
 *
 * Surviving disable/enable is not a nicety. The shell rebases the extension
 * order when it disables one: disabling any extension also disables, and then
 * re-enables, every extension after it. So a lock screen tears this extension
 * down whether or not it declares `unlock-dialog`, once for every user-only
 * extension ahead of it in the list.
 *
 * The connector is stored alongside the index because an index alone means
 * nothing once a window has been moved to another display. A note is only ever
 * read back by the monitor it names.
 *
 * A note is written, overwritten, and never cleared. Overwriting is what makes
 * a move between two secondary monitors correct itself with no special case:
 * the new monitor stamps its own connector on the way in, and the old note is
 * simply no longer the note anybody asks for. Nothing needs cleaning up on
 * unload either — this is inert data under a key nobody else uses, dying with
 * the window. That is the difference from the HIDDEN tag, which *is* cleared on
 * unload, because leaving that one behind leaves a window minimized and
 * unreachable.
 */

const PLACEMENT = Symbol.for('workspace-islands.placement');

/**
 * @param {Meta.Window} window
 * @param {string} connector the monitor the index belongs to
 * @param {number} index virtual workspace on that monitor
 */
export function stamp(window, connector, index) {
    window[PLACEMENT] = { connector, index };
}

/** Virtual workspace this window was on `connector`, or -1 if unrecorded. */
export function placementIndex(window, connector) {
    const placement = window[PLACEMENT];
    return placement?.connector === connector ? placement.index : -1;
}

/** The monitor this window was last placed on, or null if it has no note. */
export function placementConnector(window) {
    return window[PLACEMENT]?.connector ?? null;
}
