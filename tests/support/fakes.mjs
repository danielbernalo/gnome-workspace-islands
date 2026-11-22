// Like Mutter, a window that cannot be minimized ignores minimize().

let nextId = 1;

export class FakeWindow {
    constructor({
        wmClass = 'app',
        monitor = 1,
        type = 0, // Meta.WindowType.NORMAL
        canMinimize = true,
        skipTaskbar = false,
        overrideRedirect = false,
        attachedTo = null,
        minimized = false,
    } = {}) {
        this.id = nextId++;
        this.minimized = minimized;
        this.skip_taskbar = skipTaskbar;
        this._wmClass = wmClass;
        this._monitor = monitor;
        this._type = type;
        this._canMinimize = canMinimize;
        this._overrideRedirect = overrideRedirect;
        this._attachedTo = attachedTo;
    }

    minimize() {
        if (this._canMinimize)
            this.minimized = true;
    }

    unminimize() {
        this.minimized = false;
    }

    can_minimize() { return this._canMinimize; }
    get_wm_class() { return this._wmClass; }
    get_monitor() { return this._monitor; }
    get_window_type() { return this._type; }
    is_override_redirect() { return this._overrideRedirect; }
    is_attached_dialog() { return this._attachedTo !== null; }
    get_transient_for() { return this._attachedTo; }
    get_compositor_private() { return null; }
    get_title() { return `${this._wmClass} #${this.id}`; }
    toString() { return this.get_title(); }
}
