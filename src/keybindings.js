import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Keybindings {
    constructor(settings) {
        this._settings = settings;
        this._registered = [];
    }

    add(name, handler) {
        const added = Main.wm.addKeybinding(
            name,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            handler
        );

        if (added === Meta.KeyBindingAction.NONE) {
            console.warn(`workspace-islands: could not register keybinding "${name}"`);
            return false;
        }

        this._registered.push(name);
        return true;
    }

    removeAll() {
        for (const name of this._registered)
            Main.wm.removeKeybinding(name);

        this._registered = [];
    }
}
