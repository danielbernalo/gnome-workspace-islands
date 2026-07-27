# TypeScript & LSP Autocomplete in GNOME Shell Extensions

Enable TypeScript autocomplete in your editor (VS Code, GNOME Builder, etc.) to get full type suggestions and definitions for GNOME Shell, Clutter, St, GObject, and Gio.

## 1. Project Setup

Create a new directory outside of the GNOME extensions folder (e.g. `~/Projects/my-extension`) and initialize it:

```bash
npm init -y
npm install --save-dev typescript @girs/gjs @girs/gnome-shell
```

## 2. tsconfig.json Configuration

Create a `tsconfig.json` at the root of the project. This configures the compiler to target the ESModule structure expected by GNOME Shell 45+:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

## 3. Writing Code with Types

Place your source files in `src/`. For example, `src/extension.ts`:

```typescript
import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import St from "gi://St";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";

export default class MyExtension extends Extension {
    private _indicator: PanelMenu.Button | null = null;

    enable() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        
        const icon = new St.Icon({
            icon_name: "face-laugh-symbolic",
            style_class: "system-status-icon",
        });
        this._indicator.add_child(icon);
        
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
```

## 4. Compiling/Building

Use `npx tsc` (or a `Makefile`/build script) to compile your TypeScript code into JavaScript in the target directory:

```bash
npx tsc
```

This compiles your `src/extension.ts` into `dist/extension.js` with ESModules. You can then copy the `dist` contents (or symlink them) to `~/.local/share/gnome-shell/extensions/<uuid>/`.
