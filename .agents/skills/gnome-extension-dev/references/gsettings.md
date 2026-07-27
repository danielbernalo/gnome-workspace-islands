# GSettings in GNOME Shell Extensions

Use GSettings to store and retrieve user configuration settings.

## 1. Schema Definition

Create a file named `schemas/org.gnome.shell.extensions.<name>.gschema.xml` (replace `<name>` with a simple name or your UUID).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <schema id="org.gnome.shell.extensions.my-extension" path="/org/gnome/shell/extensions/my-extension/">
    <key name="show-indicator" type="b">
      <default>true</default>
      <summary>Show indicator</summary>
      <description>Whether to show the indicator icon in the status bar.</description>
    </key>
    <key name="update-interval" type="i">
      <default>60</default>
      <summary>Update interval</summary>
      <description>Interval in seconds between updates.</description>
    </key>
    <key name="display-message" type="s">
      <default>"Hello World"</default>
      <summary>Display Message</summary>
      <description>The message to display in the popup.</description>
    </key>
  </schema>
</schemalist>
```

**Rule**: The schema ID must match the `settings-schema` field in your `metadata.json` if specified.

## 2. Compilation

Before the settings can be used during development or execution, compile the schemas directory:

```bash
glib-compile-schemas schemas/
```

This generates `schemas/gschemas.compiled`. This file is required for `getSettings()` to work.

## 3. Usage in JavaScript

### Initialization

In both `extension.js` and `prefs.js` subclasses, you can get a reference to settings using:

```js
// In extension.js (subclass of Extension)
enable() {
    this._settings = this.getSettings();
}

disable() {
    this._settings = null;
}
```

```js
// In prefs.js (subclass of ExtensionPreferences)
fillPreferencesWindow(window) {
    this._settings = this.getSettings();
}
```

### Reading and Writing

```js
// Read values
const showIndicator = this._settings.get_boolean('show-indicator');
const interval = this._settings.get_int('update-interval');
const message = this._settings.get_string('display-message');

// Write values
this._settings.set_boolean('show-indicator', false);
this._settings.set_int('update-interval', 30);
this._settings.set_string('display-message', 'New Message');
```

### Signal Connections

You can listen for settings changes. Make sure to disconnect in `disable()`!

```js
enable() {
    this._settings = this.getSettings();
    this._changedId = this._settings.connect('changed::show-indicator', (settings, key) => {
        const val = settings.get_boolean(key);
        this._updateIndicatorVisibility(val);
    });
}

disable() {
    if (this._changedId) {
        this._settings.disconnect(this._changedId);
        this._changedId = null;
    }
    this._settings = null;
}
```

### Binding GSettings to UI elements

Use `bind()` to sync a setting to a property automatically:

```js
// Sync setting "show-indicator" to the St.Widget's "visible" property
this._settings.bind(
    'show-indicator',
    this._indicator,
    'visible',
    Gio.SettingsBindFlags.DEFAULT
);
```
