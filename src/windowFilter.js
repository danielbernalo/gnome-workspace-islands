// Literal, not the gi://Meta constant, so unit tests can load this module without a shell.
const WINDOW_TYPE_NORMAL = 0;

/** Only windows Mutter can minimize are parkable; transients follow their parent's minimize. */
export function isManageable(window) {
    // Never test is_on_all_workspaces(): it is true for every window on a secondary monitor.
    return !window.is_override_redirect() &&
        window.get_window_type() === WINDOW_TYPE_NORMAL &&
        !window.skip_taskbar &&
        window.can_minimize() &&
        !window.get_transient_for();
}
