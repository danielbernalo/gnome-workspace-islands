/**
 * Which windows belong in a virtual workspace.
 *
 * The model parks a window by minimizing it (see visibility.js), so the only
 * windows it can hold are the ones Mutter will minimize. Anything else, once
 * admitted, is a window the model believes is parked while it is still on
 * screen: Alt+Tab and the overview drop it as living elsewhere, and in dynamic
 * mode the workspace it was filed on can never collapse. Mutter says so in
 * the journal — "cannot be minimized, but something tried anyways" — and that
 * line is the whole of issue #18.
 *
 * What Mutter refuses, from its own window.c:
 *
 *   override-redirect   minimize() fails its precondition outright. Popups,
 *                       tooltips, X11 menus.
 *   not NORMAL          every other type loses its minimize function — the
 *                       desktop-icons window, docks, and dialogs too, attached
 *                       or not. A dialog with no parent stays untracked, so it
 *                       stays on screen on every workspace of its monitor,
 *                       which is exactly what it does natively when the
 *                       monitor is not the primary.
 *   skip-taskbar        loses it as well, so the window cannot be lost where
 *                       no taskbar would find it again.
 *   can_minimize()      false for all of the above, and also for a NORMAL
 *                       window whose Motif hints turn minimizing off. The one
 *                       term that is load-bearing; the others say why.
 *
 * And one Mutter would accept, but which must still stay out:
 *
 *   a transient         an attached dialog, or a NORMAL window set transient
 *                       for another. Mutter already hides a window whose
 *                       ancestor is minimized and brings it back with it, so a
 *                       transient follows its parent with no help. Filed on
 *                       its own it can land on the active workspace while its
 *                       parent is parked on another, and then it is hidden by
 *                       Mutter on one and by us on the other: never visible.
 *
 * Deliberately not consulted: `is_on_all_workspaces()`. With
 * `workspaces-only-on-primary` it is true for every window on a secondary
 * monitor — that stickiness is what this extension is built on — so it would
 * refuse everything. `is_always_on_all_workspaces()` only repeats what the
 * type and override-redirect terms already say.
 *
 * Checked when a window enters the model, not afterwards. A parent or a type
 * that changes after the window was admitted is not seen. In practice both
 * are set before the window is first shown, which is before it is created as
 * far as the shell is concerned.
 */

/**
 * Meta.WindowType.NORMAL. Mutter's enum, stable since the type existed.
 *
 * A literal rather than the `gi://Meta` constant so this module stays plain
 * JavaScript: the unit tests load it without a shell, where every `gi://`
 * import is an inert stand-in that compares equal to nothing.
 */
const WINDOW_TYPE_NORMAL = 0;

/**
 * True if the model may hold this window: it can be parked by minimizing,
 * and it is not riding on a parent that is parked for it.
 *
 * @param {Meta.Window} window
 */
export function isManageable(window) {
    return !window.is_override_redirect() &&
        window.get_window_type() === WINDOW_TYPE_NORMAL &&
        !window.skip_taskbar &&
        window.can_minimize() &&
        !window.get_transient_for();
}
