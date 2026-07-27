# Method Injection in GNOME Shell Extensions

Use `InjectionManager` to monkey-patch or override internal GNOME Shell methods. Always revert the overrides in `disable()` to avoid leaving modified Shell behaviors when the extension is deactivated.

## Usage Example

The following example overrides the calendar toggle behavior on the panel:

```js
import { Extension, InjectionManager } from "resource:///org/gnome/shell/extensions/extension.js";
import { Panel } from "resource:///org/gnome/shell/ui/panel.js";

export default class MyExtension extends Extension {
  enable() {
    this._injectionManager = new InjectionManager();
    
    this._injectionManager.overrideMethod(
      Panel.prototype,
      "toggleCalendar",
      (originalMethod) => {
        return function (...args) {
          console.debug("Calendar toggled!");
          // Call original method
          originalMethod.call(this, ...args);
        };
      }
    );
  }

  disable() {
    // Restores all original methods and nullifies the manager
    this._injectionManager.clear();
    this._injectionManager = null;
  }
}
```

## Best Practices
- **Revert Everything**: Failing to call `.clear()` on the `InjectionManager` in `disable()` will lead to rejected extension reviews.
- **Check Signature**: Ensure the wrapper function matches the argument structure of the overridden shell function.
