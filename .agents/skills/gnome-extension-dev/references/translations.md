# Translations (Localization) in GNOME Shell Extensions

Use Gettext for multi-lingual support in extensions.

## 1. Setup in metadata.json

Add the `gettext-domain` field, which should match your extension's UUID:

```json
{
  "uuid": "my-extension@example.com",
  "name": "My Extension",
  "gettext-domain": "my-extension@example.com"
}
```

## 2. Directory Layout

Keep translation sources under `po/` and compiled catalog binaries under `locale/`:

```text
my-extension/
  metadata.json
  extension.js
  locale/
    de/LC_MESSAGES/my-extension@example.com.mo
    fr/LC_MESSAGES/my-extension@example.com.mo
  po/
    de.po
    fr.po
    my-extension.pot
```

## 3. Initialization in JavaScript

Initialize translations inside the entry points `enable()` (for extensions) and `fillPreferencesWindow()` (for preferences):

```js
// extension.js
import { Extension, gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

export default class MyExtension extends Extension {
    enable() {
        this.initTranslations(); // Loads gettext domain
        
        // Translate a string
        const label = _("Hello, World!");
    }
}
```

```js
// prefs.js
import { ExtensionPreferences, gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class MyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this.initTranslations();
        
        const label = _("Settings Title");
    }
}
```

## 4. Extracting and Compiling Strings

### Extract strings (POT file)
Extract strings from your JavaScript source code into a `.pot` template:

```bash
mkdir -p po
xgettext --from-code=UTF-8 \
         --output=po/my-extension.pot \
         --keyword=gettext \
         --keyword=_ \
         --keyword=N_ \
         extension.js prefs.js
```

### Initialize a new translation (.po)
```bash
msginit --input=po/my-extension.pot \
        --output=po/de.po \
        --locale=de
```

### Compile to binary (.mo)
The GNOME Shell extension manager loads pre-compiled `.mo` catalog binaries from your extension's `locale/` subfolders:

```bash
mkdir -p locale/de/LC_MESSAGES
msgfmt po/de.po -o locale/de/LC_MESSAGES/my-extension@example.com.mo
```
