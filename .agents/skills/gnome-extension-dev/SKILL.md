---
name: gnome-extension-dev
description: "Build and debug GNOME Shell extensions in GJS. Use when: creating new extensions, adding panel/quick-settings UI, implementing preferences, D-Bus communication, debugging, porting versions, or preparing submissions."
---

# GNOME Shell Extensions

Build extensions for GNOME Shell 45+ using GJS with ESModules. Refer to the [GJS Architecture Overview](https://gjs.guide/extensions/overview/architecture.html) and [Imports & Modules](https://gjs.guide/extensions/overview/imports-and-modules.html) for detailed specifications.

## Leading Concepts

**Cleanup contract** — Everything created in `enable()` MUST be undone in `disable()`. This is the core invariant enforced by review.

**Process boundary** — `extension.js` runs inside `gnome-shell` (Clutter/St, no GTK). `prefs.js` runs separately (GTK4/Adwaita, no Shell APIs).

**Injection** — Override Shell methods via `InjectionManager`; always clear in `disable()`. See [Method Injection Reference](file:///home/tazztone/_coding/skills-server/skills/gnome-extension-dev/references/injection.md).

## Architecture

### Library Stack (bottom-up)

| Layer | Purpose |
|-------|---------|
| Clutter | Actor-based toolkit, layout, animations |
| St | Shell widgets: buttons, icons, labels (CSS-styleable) |
| Meta (Mutter) | Displays, workspaces, windows, keybindings |
| Shell | `global` object, app tracking, utilities |
| js/ui/ | GNOME Shell modules (Main, Panel, PopupMenu, QuickSettings) |

### Import Conventions

**extension.js**:
```js
import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";

import { Extension, gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";
```

**prefs.js**:
```js
import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import Adw from "gi://Adw";
import Gio from "gi://Gio";

import { ExtensionPreferences, gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
```

**Rule**: Never import GTK/Gdk/Adw in `extension.js`. Never import Clutter/Meta/St/Shell in `prefs.js`.

## File Structure

See the [Anatomy of an Extension](https://gjs.guide/extensions/overview/anatomy.html) guide for details on folder layouts.

### Required
- **`metadata.json`** — UUID, name, description, shell-version, url
- **`extension.js`** — Default export: subclass of `Extension`

### Optional
- **`prefs.js`** — Subclass of `ExtensionPreferences` (GTK4/Adwaita)
- **`stylesheet.css`** — CSS for St widgets (extension process only)
- **`schemas/`** — GSettings schema XML + compiled binary. See [GSettings Reference](file:///home/tazztone/_coding/skills-server/skills/gnome-extension-dev/references/gsettings.md).
- **`locale/`** — Compiled Gettext `.mo` files. See [Translations Reference](file:///home/tazztone/_coding/skills-server/skills/gnome-extension-dev/references/translations.md).

### metadata.json Template
```json
{
  "uuid": "my-extension@example.com",
  "name": "My Extension",
  "description": "Does something useful",
  "shell-version": ["47", "48", "49"],
  "url": "https://github.com/user/my-extension",
  "gettext-domain": "my-extension@example.com",
  "settings-schema": "org.gnome.shell.extensions.my-extension"
}
```

## Lifecycle: enable()/disable()

Refer to the [Extension Lifecycle](https://gjs.guide/extensions/development/creating.html#extension-lifecycle) guide for detailed state transitions.

```js
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

export default class MyExtension extends Extension {
  enable() {
    // Create objects, connect signals, add UI, init translations
  }

  disable() {
    // Undo everything from enable():
    // - Destroy all widgets
    // - Disconnect all signals
    // - Remove all GLib.timeout/idle sources
    // - Unexport DBus interfaces
    // - Null all references
  }
}
```

**Rules**:
- Do NOT create GObject instances or connect signals in `constructor()`
- `constructor()` only sets static data (RegExp, Map) and calls `super(metadata)`
- `disable()` is called on lock screen (unless `session-modes` includes `unlock-dialog`)

## Branches

### Branch: Create New Extension

1. **Setup File Structure** — Create `metadata.json`, `extension.js`, and `stylesheet.css`.
2. **Setup Dev Environment (Optional)** — Configure TypeScript autocomplete. See [TypeScript & LSP Reference](file:///home/tazztone/_coding/skills-server/skills/gnome-extension-dev/references/typescript-lsp.md).
3. **Configure Settings (Optional)** — Create GSettings schema XML. See [GSettings Reference](file:///home/tazztone/_coding/skills-server/skills/gnome-extension-dev/references/gsettings.md).
4. **Implement Lifecycle** — Subclass `Extension` in `extension.js` and obey the cleanup contract.
5. **Deploy Locally** — Symlink or copy the extension folder to your local extensions directory:
   ```sh
   mkdir -p ~/.local/share/gnome-shell/extensions/
   ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/my-extension@example.com
   ```
6. **Run Nested Session for Testing**:
   ```sh
   # GNOME 49+
   dbus-run-session gnome-shell --devkit --wayland
   # GNOME 48 and earlier
   dbus-run-session gnome-shell --nested --wayland
   ```
7. **Enable and Verify** — Enable the extension inside the nested session:
   ```sh
   gnome-extensions enable my-extension@example.com
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

**Completion Criteria**: 
- Extension loads without warning or stack trace logs.
- Disabling and re-enabling repeatedly leaves no leaking UI components or active event sources.

---

### Branch: Add Panel Indicator

1. **Create Panel Button** — Instantiate `PanelMenu.Button` in `enable()`.
2. **Add Widget** — Create St widget child (e.g. `St.Icon`) and append it to the button.
3. **Inject to Panel** — Insert into the status bar area via `Main.panel.addToStatusArea(this.uuid, this._indicator)`.
4. **Perform Cleanup** — Call `destroy()` on the indicator widget and nullify the pointer in `disable()`.

**Completion Criteria**: 
- Icon renders in panel status area.
- Interaction with the panel button functions without throwing errors.
- Disabling the extension deletes the indicator actor from the panel tree.

---

### Branch: Add Quick Settings Toggle

1. **Create Quick Settings Toggle** — Create a `QuickSettings.MenuToggle` in `enable()`.
2. **Bind Action** — Connect `notify::checked` to handle toggle shifts.
3. **Inject to System Menu** — Register into the Quick Settings menu tree: `QuickSettings.systemMenu._addItems(this._toggle)`.
4. **Perform Cleanup** — Call `destroy()` on the toggle actor in `disable()`.

**Completion Criteria**: 
- Toggle button appears inside Quick Settings menu.
- Toggling invokes configured state callbacks cleanly.
- Toggle is fully removed when extension is disabled.

---

### Branch: Add Popup Menu to Panel

1. **Create Base Button** — Instantiate `PanelMenu.Button`.
2. **Add Menu Items** — Create `PopupMenu.PopupMenuItem` or `PopupMenu.PopupSeparatorMenuItem` and append using `this._indicator.menu.addItem(item)`.
3. **Register Indicator** — Call `Main.panel.addToStatusArea()` to show the panel button.
4. **Perform Cleanup** — Calling `destroy()` on the panel button cleans up the popup menu recursively.

**Completion Criteria**: 
- Clicking panel icon drops down the configured menu items.
- Selecting menu actions initiates callbacks.
- Disabling the extension clears the panel menu.

---

### Branch: Implement Preferences (GTK4/Adwaita)

1. **Subclass Preferences** — Implement `fillPreferencesWindow(window)` in `prefs.js` using `ExtensionPreferences`.
2. **Construct UI** — Build the preference window using `Adw.PreferencesPage` and `Adw.PreferencesGroup`.
3. **Bind Settings** — Use GSettings to back the user preferences. See [GSettings Reference](file:///home/tazztone/_coding/skills-server/skills/gnome-extension-dev/references/gsettings.md).

**Completion Criteria**: 
- Running `gnome-extensions prefs my-extension@example.com` displays the Adwaita preference window.
- Changing controls updates settings and binds values persist across extensions reload.

---

### Branch: Communicate via D-Bus

1. **Define D-Bus XML** — Write interface schemas.
2. **Implement Communication** — Use proxy wrapper to call external interfaces, or wrap your JS object to export commands. See [D-Bus Reference](file:///home/tazztone/_coding/skills-server/skills/gnome-extension-dev/references/dbus.md).
3. **Perform Cleanup** — Make sure to close proxies or call `unexport()` in `disable()`.

**Completion Criteria**: 
- Extension correctly executes methods or reads signals from external DBus services.
- Exported interfaces are removed cleanly without leaking paths.

---

### Branch: Debug Extension

Note: Since GJS uses ESModules (GNOME 45+), source files are cached in the Shell process. You must restart the nested GNOME Shell instance to apply code changes.

1. **Isolate** — Run a nested window environment using `dbus-run-session`.
2. **Stream Logs** — Filter journalctl stream for warnings:
   ```sh
   journalctl -f -o cat /usr/bin/gnome-shell
   ```
3. **Force Reload** (only works if module imports/schemas are unchanged):
   ```sh
   dbus-send --print-reply --dest=org.gnome.Shell /org/gnome/Shell org.gnome.Shell.Eval string:"Main.extensionManager.enableExtension('my-extension@example.com')"
   ```

**Completion Criteria**: 
- Runtime bugs or memory leaks identified via active logs.
- Safe enablement cycle with no warnings.

---

### Branch: Port to New GNOME Version

1. **Audit Version Changes** — Consult the target shell release notes for breaking GJS changes (e.g. ESModules in 45, Panel API in 48).
2. **Update Metadata** — Edit `shell-version` in `metadata.json`.
3. **Fix Deprecations** — Resolve obsolete imports or actor properties.
4. **Validate** — Test execution inside a nested session of the target GNOME environment.

**Completion Criteria**: 
- Extension activates cleanly in target GNOME environment with no console warnings.

---

### Branch: Prepare for Submission

1. **Run Auditing Checks** — Confirm no active GObject, source, or signal listeners leak outside `disable()`.
2. **Create Pack Archive** — Build submission package:
   ```sh
   gnome-extensions pack --podir=po --extra-source=utils.js .
   ```
3. **Upload Package** — Submit generated `.zip` to extensions.gnome.org.

**Completion Criteria**: 
- Build pack succeeds with no validation issues.
- Package passes automated submission reviews.

## Common Patterns

### Signal Connection (with cleanup)
```js
enable() {
  this._handlerId = someObject.connect('some-signal', () => { /* ... */ });
}
disable() {
  if (this._handlerId) {
    someObject.disconnect(this._handlerId);
    this._handlerId = null;
  }
}
```

### Timeout (with cleanup)
```js
enable() {
  this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    // do work
    return GLib.SOURCE_CONTINUE;
  });
}
disable() {
  if (this._timeoutId) {
    GLib.Source.remove(this._timeoutId);
    this._timeoutId = null;
  }
}
```



## Key Resources

- **GJS API Docs**: https://gjs-docs.gnome.org/
- **GNOME Shell Source**: https://gitlab.gnome.org/GNOME/gnome-shell/-/tree/main/js/ui
- **Extensions Guide**: https://gjs.guide/extensions/
- **Review Guidelines**: https://gjs.guide/extensions/review-guidelines/review-guidelines.html
- **Support & Community**:
  - [GNOME Discourse (Extensions)](https://discourse.gnome.org/tag/extensions)
  - [Matrix Chat Room](https://matrix.to/#/#extensions:gnome.org)
  - [JustPerfection's Tutorial Videos](https://www.youtube.com/watch?v=iMyR5lJf7dU&list=PLr3kuDAFECjZhW-p56BoVB7SubdUHBVQT)
- **General GJS/GObject Guides**:
  - [GObject Basics](https://gjs.guide/guides/gobject/basics.html)
  - [Asynchronous Programming](https://gjs.guide/guides/gjs/asynchronous-programming.html)
  - [File Operations (Gio)](https://gjs.guide/guides/gio/file-operations.html)
- **Additional Topics**:
  - [St Widgets Guide](https://gjs.guide/extensions/topics/st-widgets.html)
  - [Dialogs Guide](https://gjs.guide/extensions/topics/dialogs.html)
  - [Translations/Localization](https://gjs.guide/extensions/development/translations.html)
  - [Accessibility (A11y)](https://gjs.guide/extensions/development/accessibility.html)