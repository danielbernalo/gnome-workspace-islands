# Dani Workspaces

Independent per-monitor workspaces for GNOME Shell 50 — rotate through workspaces on one monitor without disturbing what's on the others. **No tiling.**

> Status: early. Every roadmap item is implemented; the hide strategy was settled by the Phase 0.b spike — see [How hiding works, and why](#how-hiding-works-and-why).

## The problem

GNOME offers exactly two multi-monitor workspace modes, neither of which is what people usually want:

- **Workspaces on all displays** — switching a workspace switches *every* monitor at once.
- **Workspaces on primary only** — secondary monitors are frozen on a single fixed set of windows.

Truly independent workspaces per monitor, macOS style, [have been requested for years](https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/5195) and do not exist natively. No maintained extension provides them for GNOME 50 either.

## Why it's hard

In Mutter a workspace belongs to the **display**, not to the monitor. The data model is `window → workspace`; the monitor isn't part of that relationship, and only one workspace is active at a time across the whole display.

On top of that, `MetaWindowActor`s can't be freely relocated. From PaperWM's `tiling.js`:

> Clones are necessary due to restrictions mutter places on MetaWindowActors. WindowActors can only live in `global.window_group` and can't be moved reliably outside the monitor.

That's why PaperWM builds a full Clutter clone pipeline — and why it ended up a tiling window manager. **The tiling is a consequence of that architecture, not the goal.**

## The approach here

The opposite direction, which is what keeps tiling out of the picture.

PaperWM forces `workspaces-only-on-primary = false` (see its `patches.js`) because it wants real native workspaces per monitor, which then requires clones. This extension **keeps that setting `true`**.

With it on, Mutter marks windows on non-primary monitors as *on-all-workspaces* — sticky. They're already present on every workspace, immune to native switches. So nothing needs cloning, and the problem collapses to a much smaller one:

**decide which windows are shown.**

```
Primary monitor              Secondary monitor
────────────────             ─────────────────
Native GNOME workspaces      Virtual workspaces
Super+1..4, untouched        Map<index, Set<window>>
                             switch = show set B, hide set A
```

No clones. No rendering changes. No tiling.

## How hiding works, and why

Everything rests on how a window is made to stop being visible. Two candidates were built side by side and compared under real use:

|                     | `actor-hide`                        | `minimize` ✅ chosen              |
| ------------------- | ----------------------------------- | --------------------------------- |
| Visual              | Instant, no animation               | Minimize animation                |
| Window state        | Untouched                           | Mutter knows it's minimized       |
| Focus               | Must be handled manually            | Handled by the WM                 |
| Survives ws switch  | **No — gets overwritten**           | **Yes**                           |
| Risk                | Inconsistent state on a crash       | Lower                             |

**`actor-hide` is overwritten by native workspace switches.** A workspace switch walks the window actors and shows those belonging to the incoming workspace. Sticky windows belong to *every* workspace, so Mutter showed all of them and every virtual workspace landed on screen at once.

That could be worked around by reasserting visibility on `active-workspace-changed` at idle — but that is a race against the shell, not a fix: re-hiding what the shell just showed, one frame later.

`minimize` is structurally immune. Minimized state is real window state, not a flag on an actor that Mutter recomputes, so a workspace switch leaves it alone. Nothing to reassert, no race, and focus handover comes free because the window manager already knows a minimized window cannot hold focus.

The cost is a minimize animation and a minimized marker in the dash. Both were judged acceptable; the race was not.

## Requirements

- GNOME Shell 50, Wayland
- `org.gnome.mutter workspaces-only-on-primary = true` (the extension warns if it isn't)
- At least two monitors
- **PaperWM disabled** — both extensions fight over that setting with opposite values

## Development

Nested testing requires **Mutter Devkit**, a separate package:

```bash
sudo pacman -S mutter-devkit    # Arch / CachyOS
```

Then:

```bash
make install   # compile schemas + symlink src/ into GNOME's extension dir
make nested    # launch Mutter Devkit
make logs      # follow gnome-shell logs
make status    # install + enable state
```

Add a **second virtual display** from the devkit UI before testing — this extension only acts on *secondary* monitors, so a single-display session gives it nothing to do.

Three things that cost time if you don't know them:

- **Wayland has no `Alt+F2 → r`.** The shell cannot be restarted in place; test nested, then log out and back in for a real session.
- **`--nested` was removed in GNOME 49.beta1.** Mutter Devkit replaced it.
- **`--wayland` alone does not run nested.** It tries to take over the session and dies with `EBUSY`. `--virtual-monitor` forces the same mode. Neither is a substitute for devkit.

## Default shortcuts

Shortcuts act on the **monitor that has focus**. On the primary monitor they're a no-op, since native workspaces already cover it.

| Shortcut                     | Action                                  |
| ---------------------------- | --------------------------------------- |
| `Super+Alt+1..4`             | Switch to virtual workspace N           |
| `Super+Alt+←` / `→`          | Previous / next virtual workspace       |
| `Super+Alt+Shift+←` / `→`    | Move focused window between workspaces  |

A **three-finger touchpad swipe** over a secondary monitor does the same thing, following your fingers. Over the primary monitor it stays GNOME's.

## What you see

Nothing that GNOME doesn't already draw.

The **panel dots** — the ones that replaced the "Activities" label in GNOME 48 — follow the monitor that has focus. Working on the primary monitor, they show native workspaces and behave exactly as they always did. Move focus to a secondary monitor and they show that monitor's virtual workspaces instead. One indicator, always describing the screen you're on.

The shell's own dots are *hidden*, never destroyed: `WorkspaceIndicators` is a module-private `const` in `panel.js`, so a destroyed one could not be rebuilt on unload.

The **on-screen popup** is the same pill GNOME shows on a workspace switch, on the monitor that switched. Its own popup can't be reused — with `workspaces-only-on-primary` on it pins itself to the primary monitor and counts native workspaces — but its style classes can, so it is the same pill.

Both are driven by an `St.Adjustment` holding a *fractional* workspace position, which is how `panel.js` does it. Only whole numbers are written today. That fraction is the seam a touchpad gesture plugs into.

## Layout

```
src/
├── extension.js      lifecycle, signals, shortcut handlers
├── monitorState.js   per-monitor virtual workspace model (keyed by connector)
├── visibility.js     hiding via minimize, and why
├── slide.js          touchpad gesture and the sliding switch
├── keybindings.js    keybinding registration and teardown
├── persistence.js    saved arrangement across sessions and hotplug
├── indicator.js      takes over the panel's own workspace dots
├── switcherPopup.js  on-screen dots, on the monitor that switched
├── altTab.js         window-switcher filtering
├── overview.js       the four shell seams the overview needs
├── workspacesView.js scrolling pages and thumbnail strip, ported
├── prefs.js          GTK4/Adwaita preferences (separate process)
├── stylesheet.css    indicator styling
└── schemas/          gsettings schema
```

## What persists, and what can't

Windows have **no stable identity across sessions** — a `MetaWindow` is a live object, and no id survives a logout. So "put this window back on virtual workspace 2" is not implementable. What is stored instead:

- **Active workspace per monitor**, keyed by connector, so a display returns to the arrangement it was left on.
- **Per-application placement** (by `WM_CLASS`). New windows of an app land where that app was last put. A heuristic by design: two windows of the same app go to the same place, which is usually right and always correctable by moving the window.

## Roadmap

- [x] 0.a Repo scaffold
- [x] 0.b Visibility spike — `minimize` won
- [x] 1 Core state and window tracking
- [x] 2 Keybindings
- [x] 3 Panel indicator
- [x] 4 Overview filtering
- [x] 5 Alt+Tab filtering
- [x] 6 Persistence and hotplug
- [x] Preferences window
- [x] 7 On-screen switcher popup
- [x] 8 Panel dots follow the focused monitor
- [x] 9 Touchpad swipe on secondary monitors
- [x] 10 Slide preview driven by the swipe
- [x] 11 Virtual workspaces laid out in the overview

**11** was on the "deliberately not built" list until it was asked for, and the
reason it was there still stands: it is the most update-fragile code here. All
four shell seams it depends on live in `overview.js` for that reason — when a
GNOME update breaks this extension, that is the file to open.

`WorkspacesView` and `ThumbnailsBox` are both exported and neither is usable:
they are built from `MetaWorkspace`, and a virtual workspace has none to give
them. So the layout arithmetic is ported into `workspacesView.js` — the spacing
rule that makes neighbours peek by the right amount, the centre-and-shift of the
scrolling row, the 0.94 scale on whatever is not centred — and the machinery
around it is not. Fit-mode interpolation is skipped because `_getInitialBoxes`
skips it for non-primary monitors anyway.

The thumbnails could not be copied even in principle:

```js
// WorkspaceThumbnail._isOverviewWindow
return !win.get_meta_window().skip_taskbar &&
       win.get_meta_window().showing_on_its_workspace();
```

`showing_on_its_workspace()` is false for a minimized window, so GNOME's
thumbnails deliberately omit them — which here is every window on every
inactive virtual workspace. A faithful copy would render identical empty
rectangles. The pages avoid this because `WindowPreview` builds on
`Shell.WindowPreviewLayout`, a C layout that paints the window texture instead
of cloning a possibly unmapped actor, and the strip here uses the same thing.

Clicking a window needed no code at all: it un-minimizes, and the follow logic
already reads that as "take me there".

**9 and 10 are one item in two lines.** In GNOME the live preview *is* the
gesture: `MonitorGroup` binds its `progress` to the same adjustment the panel
dots read, so a single fractional number drives the sliding windows and the
stretching dots together. Reproducing that shape is what makes a switch feel
native instead of imitated, and building either half alone would have meant
building it twice.

The gesture is not simply free for the taking, which cost a wrong assumption
before it cost code. `WorkspaceAnimationController._switchWorkspaceBegin` does
decline non-primary monitors without calling `confirmSwipe()` — but one layer
down, `TouchpadSwipeGesture` enters its HANDLING state on swipe *orientation*
alone, knows nothing about monitors, and returns `Clutter.EVENT_STOP` regardless
of whether anyone confirmed. Emission of `event` stops at the first handler
returning true, and the shell connects at startup while an extension connects at
enable(). A second SwipeTracker would never receive an event. So the controller's
three swipe handlers are overridden instead, and the extension rides the tracker
that already exists.

The slide walks back the "no clones" claim above: showing two workspaces side by
side means cloning their windows. Transient clones, destroyed with the cover at
the end of the switch — not PaperWM's permanent pipeline — but clones. It
collides with the hide strategy too: a `Clutter.Clone` of a minimized window
paints nothing, so the incoming workspace has to be un-minimized behind an
opaque cover before it can be cloned, and the outgoing one can only be minimized
once the slide is over.

Both the gesture and the animation can be switched off in preferences, which
also leaves the shortcuts falling back to the plain minimize behaviour.

### Deliberately not built

**Filtering the app switcher.** `AppSwitcher` is a module-private `const` built inline inside `AppSwitcherPopup._init`; patching it means reimplementing that constructor. Instead, an outside un-minimize is treated as intent: pick a window from virtual workspace 2 via the app switcher, dash or a notification, and that monitor switches to workspace 2 and takes you there. Better behaviour than hiding it, at none of the risk.

**A panel menu for switching a monitor you are not on.** The indicator used to be its own panel button with a menu listing every monitor's workspaces. It was dropped when the indicator moved into the Activities button: a second panel button with a dropdown is the most obvious tell that an extension is installed, and the shortcuts already cover switching the monitor you are working on. Switching a monitor you are *not* focused on is the only thing lost, and it is rare enough not to earn back the UI.

## License

GPL-2.0-or-later
