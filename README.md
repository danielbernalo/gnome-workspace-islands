<div align="center">

<img src="docs/banner.png" alt="Two cartoon monitors shaking hands at a control panel, each with its own stack of workspaces" width="560">

# Workspace Islands

</div>

**Independent workspaces on every monitor, for GNOME Shell 50.** Switch workspaces on one screen and the others stay exactly where you left them. No tiling, no new window manager, no relearning GNOME.

Each monitor is its own island: it keeps its own set of workspaces, and nothing you do on one disturbs the rest.

> **Status: early.** Everything described here works, but it has been used by one person on one machine. Bug reports are genuinely useful right now.

## The problem

GNOME gives you exactly two multi-monitor modes, and neither is what most people want:

| Mode | What happens |
| --- | --- |
| Workspaces on all displays | Switching a workspace switches **every** monitor at once |
| Workspaces on primary only | Secondary monitors are **frozen** on one fixed set of windows |
| **Workspace Islands** | Each monitor rotates through its **own** workspaces, independently |

Truly independent per-monitor workspaces, macOS style, [have been requested for years](https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/5195) and do not exist natively.

The closest existing extension is [Switch workspaces on active monitor](https://extensions.gnome.org/extension/2911/), which simulates the switch on whichever monitor is active and supports up to GNOME 48. This one targets 50, keeps per-monitor state that survives a logout, and integrates with the panel indicator, the overview and the touchpad gestures rather than only remapping a shortcut.

## Before you install

- [ ] **GNOME Shell 50**, on Wayland
- [ ] **At least two monitors** — the extension only acts on non-primary ones, so a single display gives it nothing to do
- [ ] **PaperWM disabled**, if you have it — the two fight over the same mutter setting with opposite values
- [ ] `org.gnome.mutter workspaces-only-on-primary` set to `true`

The last one is the setting everything rests on. The extension checks it, warns you if it is off, and offers a one-click fix in its preferences. To set it by hand:

```bash
gsettings set org.gnome.mutter workspaces-only-on-primary true
```

## Install

Not on [extensions.gnome.org](https://extensions.gnome.org) yet — that route needs review time. Until then, grab the bundle from [Releases](../../releases/latest):

```bash
gnome-extensions install --force workspace-islands@danielbernalo.github.io.shell-extension.zip
```

<details>
<summary>Or build it from source</summary>

```bash
git clone https://github.com/danielbernalo/gnome-workspace-islands
cd gnome-workspace-islands
make pack
gnome-extensions install --force workspace-islands@danielbernalo.github.io.shell-extension.zip
```

Needs `python3` and `glib-compile-schemas`, both of which you already have on a GNOME system. The build is deterministic — the same commit always produces the same archive, so you can check yours against the released one.

</details>

Now **log out and back in**. Wayland cannot reload the shell in place, and until the session restarts the shell does not know the extension exists.

That last part is why enabling comes *after* the restart and not before — run it any earlier and you get `Extension … does not exist`, because you are asking a shell that has not looked yet:

```bash
gnome-extensions enable workspace-islands@danielbernalo.github.io
```

The Extensions app does the same thing with a switch, if you would rather.

Verify it came up:

```bash
gnome-extensions info workspace-islands@danielbernalo.github.io   # State: ACTIVE
```

If it says `ERROR`, open the Extensions app — it shows the failure with a stack trace, which is the fastest way to report a useful bug.

## Using it

Everything acts on **the monitor holding the focused window**. On the primary monitor the shortcuts do nothing on purpose: GNOME's own workspaces already cover it, and hijacking them would break what already works.

### Keyboard

| Shortcut | Action |
| --- | --- |
| `Super+Alt+1…4` | Switch to virtual workspace N |
| `Super+Alt+←` / `→` | Previous / next virtual workspace |
| `Super+Alt+Shift+←` / `→` | Move the focused window to the previous / next workspace |

All of them are rebindable in preferences.

> **If you raise the workspace count above 4**, the extra ones have no shortcut until you assign it. `Super+Alt+5…8` are deliberately unbound by default so they do not silently claim keys you may already use.

### Touchpad and mouse

| Gesture | Where | Action |
| --- | --- | --- |
| Three-finger swipe ← / → | On a secondary monitor | Switch workspace, following your fingers |
| Three-finger swipe ← / → | In the overview | Same, on the monitor under the pointer |
| Two-finger scroll | In the overview | Switch workspace |
| Mouse wheel | In the overview | Switch workspace |
| `Super` + mouse wheel | On a secondary monitor | Switch workspace, one notch at a time |

Over the primary monitor every gesture stays GNOME's own, untouched.

### The overview

Press `Super`. A secondary monitor now scrolls through its virtual workspaces the way the primary scrolls through native ones — active workspace centred, neighbours peeking at the edges, thumbnail strip above.

- **Click a window** to go to it. The monitor switches to whichever workspace holds it.
- **Drag a window onto a thumbnail** to move it to that workspace.
- **Drag a window in from the primary monitor** and drop it on the page you are looking at.

### Reading where you are

The **workspace dots in the top bar** — the ones that replaced the "Activities" label in GNOME 48 — follow the monitor you are working on. Focused on the primary, they show native workspaces and behave exactly as they always have. Move focus to a secondary monitor and the same dots show that monitor's workspaces instead. One indicator, always describing the screen you are on.

On a switch, the familiar **pill with dots** appears on the monitor that changed, not on the primary.

## Preferences

Open with the gear in the Extensions app, or:

```bash
gnome-extensions prefs workspace-islands@danielbernalo.github.io
```

### Virtual workspaces

| Option | Default | What it does |
| --- | --- | --- |
| **Workspaces per monitor** | `4` | How many workspaces each secondary monitor gets. Range 2–8. Applies to every secondary monitor; the primary keeps using GNOME's own. |

Lowering the count folds everything beyond the new end into the last workspace rather than losing those windows.

### Switching

All three default to **on**, and each buys its polish with something real. That is why they are switches and not assumptions.

| Option | Default | What it does | Turn it off if… |
| --- | --- | --- | --- |
| **Touchpad gesture** | on | Three-finger swipe on secondary monitors | You want that gesture free, or it fights something else you use |
| **Slide animation** | on | Workspaces slide across like GNOME's, instead of showing the minimize animation | You see visual artifacts, or you are on hardware where the extra work costs you. This is the cheapest thing to switch off — everything else keeps working |
| **On-screen indicator** | on | The dots pill on the monitor that changed | You find it noisy. The panel dots already tell you where you are |

The slide is the one worth understanding: making two workspaces visible side by side requires briefly cloning their windows. The clones live for about a quarter second and are destroyed with the animation, but if anything ever looks wrong during a switch, this switch is the first thing to try.

### Troubleshooting

| Option | Default | What it does |
| --- | --- | --- |
| **Debug logging** | off | Logs every workspace switch, gesture and drop to the journal |

With it on, watch what the extension is doing:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep workspace-islands
```

The **Diagnostics** section of the same page shows the live state of `workspaces-only-on-primary` and offers a button to turn it back on. It is there because that setting is the one thing other software flips underneath you, and when it is off nothing works and the reason is invisible.

## What survives a lock, an unplug or a suspend

**Everything.** Each window carries a note saying which monitor and which workspace it was on, and the note lives on the window itself — so it outlasts the screen locking, the monitors going away and coming back, and the extension being turned off and on again. Come back from lunch to a redocked laptop and every window is on the workspace you left it on.

This is the common case, and it is worth being precise about why it works: none of those events ends the session. The windows are the same windows the whole time, so the arrangement was never really lost — it was being thrown away and guessed back.

## What survives a logout

A logout is the one that genuinely cannot be complete. Windows have **no stable identity across sessions** — a window is a live object, and no id outlives a logout. So "put this exact window back on workspace 2" is not implementable by anyone. What is stored instead:

- **Which workspace each monitor was left on**, keyed by the physical connector — the name the backend gives the output, like `HDMI-2` — so a display that comes back returns to its own arrangement no matter which position it comes back in.
- **Where each application belongs.** New windows of an app land where you last put that app. A deliberate heuristic: two windows of the same app go to the same place, which is usually right and always correctable by moving the window.

## Troubleshooting

**`gnome-extensions enable` says the extension does not exist.** You have not logged out yet. That command asks the running shell, and on Wayland the shell only scans for extensions when the session starts. Install, restart the session, then enable.

**A shortcut does nothing.** You are probably focused on the primary monitor, where it is a no-op by design. Turn on debug logging and the journal will say so explicitly.

**A window vanished.** The extension hides windows by minimizing them, so anything on an inactive workspace is minimized — visible in the dash, restorable from there. Clicking it un-minimizes it *and* takes you to the workspace it lives on. Disabling the extension restores everything unconditionally.

**Something is badly wrong and you want out.** This turns off every user extension immediately, without a logout and without uninstalling anything:

```bash
gsettings set org.gnome.shell disable-user-extensions true
```

Set it back to `false` when you are done. To disable only this one:

```bash
gnome-extensions disable workspace-islands@danielbernalo.github.io
```

**Workspaces are leaking into each other.** Something turned `workspaces-only-on-primary` off. The extension notifies you when this happens; the Diagnostics section in preferences turns it back on.

**Windows show a minimized marker in the dash.** Expected. Minimizing is how windows are parked, and it was chosen over the alternatives because it is the only approach that survives a native workspace switch — see below.

## How it works

### Why this is hard

In Mutter a workspace belongs to the **display**, not to the monitor. The data model is `window → workspace`; the monitor is not part of that relationship, and only one workspace is active at a time across the whole display.

On top of that, window actors cannot be freely relocated. From PaperWM's `tiling.js`:

> Clones are necessary due to restrictions mutter places on MetaWindowActors. WindowActors can only live in `global.window_group` and can't be moved reliably outside the monitor.

That is why PaperWM builds a full clone pipeline — and why it ended up a tiling window manager. **The tiling is a consequence of that architecture, not the goal.**

### The approach here

The opposite direction, which is what keeps tiling out of the picture.

PaperWM forces `workspaces-only-on-primary = false` because it wants real native workspaces per monitor, which then requires clones. This extension **keeps that setting `true`**.

With it on, Mutter marks windows on non-primary monitors as *on-all-workspaces* — sticky. They are already present on every workspace, immune to native switches. So nothing needs cloning, and the problem collapses to a much smaller one:

**decide which windows are shown.**

```
Primary monitor              Secondary monitor
────────────────             ─────────────────
Native GNOME workspaces      Virtual workspaces
Super+1..4, untouched        Map<index, Set<window>>
                             switch = show set B, hide set A
```

### Layout

```
src/
├── extension.js      lifecycle, signals, shortcut handlers
├── monitorState.js   per-monitor workspace model (keyed by connector)
├── visibility.js     hiding via minimize, and why
├── slide.js          touchpad gesture and the sliding switch
├── keybindings.js    keybinding registration and teardown
├── persistence.js    saved arrangement across sessions and hotplug
├── indicator.js      takes over the panel's own workspace dots
├── switcherPopup.js  on-screen dots, on the monitor that switched
├── altTab.js         window-switcher filtering
├── overview.js       the shell seams the overview needs
├── workspacesView.js scrolling pages and thumbnail strip, ported
├── prefs.js          GTK4/Adwaita preferences (separate process)
└── schemas/          gsettings schema
```

## Questions this design invites

Anyone reading the source — a reviewer, or you in six months — will hit the same
handful of "why on earth". Here they are, answered.

### Why does it patch so much of GNOME Shell?

Because the thing it does has no public API anywhere. Mutter's data model is
`window → workspace`, with the monitor absent from that relationship; the shell
draws secondary monitors through a class chosen by a setting; and the gesture
machinery decides which monitor a swipe belongs to in a place extensions cannot
reach. Every seam below exists because there is no supported way to do the same
thing.

Eight of them, all reachable from two files:

| Seam | Why |
| --- | --- |
| `Workspace._isOverviewWindow` | Splits one page of "every window on this monitor" into N virtual ones |
| `Workspace.handleDragOver` / `acceptDrop` | The originals compare monitors, which is true of every page, so every drop was refused |
| `SecondaryMonitorDisplay._updateWorkspacesView` | Chooses the scrolling view instead of the single-workspace one |
| `WorkspacesDisplay._onScrollEvent` | Wheel scrolling is declined for non-primary monitors |
| `WindowSwitcherPopup._getWindowList` | Keeps parked windows out of the window switcher |
| Two `SwipeTracker` replacements | See below |

Each override degrades rather than throws: a missing method costs a feature and
logs a warning, it does not take the session down. All of them are undone in
`disable()`.

### Why replace the swipe tracker instead of overriding its handlers?

Because overriding them does nothing, silently. The shell connects like this:

```js
swipeTracker.connect('begin', this._switchWorkspaceBegin.bind(this));
```

`.bind()` resolves the method and captures that function object at construction
time — shell startup, long before any extension is enabled. Replacing the
method afterwards, on the prototype or the instance, leaves the already-bound
handler pointing at the original. The override installs, reports success, and is
never called.

Adding a second tracker alongside does not work either. `TouchpadSwipeGesture`
enters its handling state on swipe *orientation* alone, knows nothing about
monitors, and returns `Clutter.EVENT_STOP` even when its owner declined the
gesture. Emission of `event` stops at the first handler returning true, and the
shell connects at startup while an extension connects at `enable()`.

So the shell's tracker is disabled — a disabled tracker's gestures return
`EVENT_PROPAGATE`, which is what frees the events — and a replacement takes its
place on `_swipeTracker`, where the shell's own `_updateSwipeTracker` and
`_updateTrackerOrientation` keep managing it. Gestures that are not ours are
handed to the original methods, which are left unpatched precisely so they can
be called.

### Why do the thumbnails use `Shell.WindowPreviewLayout` and not `Clutter.Clone`?

Because a clone of a minimized window paints nothing, and on an inactive virtual
workspace every window is minimized.

GNOME's own thumbnails do not have to care — they filter minimized windows out
on purpose:

```js
// WorkspaceThumbnail._isOverviewWindow
return !win.get_meta_window().skip_taskbar &&
       win.get_meta_window().showing_on_its_workspace();
```

`showing_on_its_workspace()` is false when minimized. Copying that faithfully
would have rendered a row of identical empty rectangles. `WindowPreview` avoids
it by building on `Shell.WindowPreviewLayout`, a C layout manager that paints
the window's texture rather than cloning a possibly unmapped actor; the strip
uses the same thing.

### Why minimize windows instead of hiding their actors?

Both were built and compared under real use:

| | `actor-hide` | `minimize` ✅ chosen |
| --- | --- | --- |
| Visual | Instant, no animation | Minimize animation |
| Window state | Untouched | Mutter knows it is minimized |
| Focus | Must be handled manually | Handled by the WM |
| Survives a native workspace switch | **No — gets overwritten** | **Yes** |
| Risk | Inconsistent state on a crash | Lower |

Hiding the actor is instant and animation-free, and it loses a race. A native
workspace switch walks the window actors and shows those belonging to the
incoming workspace. With `workspaces-only-on-primary` on, secondary-monitor
windows are sticky — they belong to *every* workspace — so the shell showed all
of them and every virtual workspace landed on screen at once.

That could be papered over by re-hiding a frame later, which is a race against
the shell rather than a fix. Minimized state is real window state that Mutter
does not recompute, so a switch leaves it alone. Focus handover comes free,
because the window manager already knows a minimized window cannot hold focus.

The visible cost is the minimize animation and a marker in the dash. Both were
judged acceptable; the race was not.

### It says "no clones", then it clones. Which is it?

Both, and the distinction is lifetime.

The core model needs no clones at all: windows stay where they are and the
extension decides which are shown. That is what keeps this from becoming a
tiling window manager, which is the trap the alternative approach falls into.

The slide animation is the exception. Showing two workspaces side by side means
cloning their windows — there is no other way, because window actors cannot be
moved outside their monitor. Those clones live for the ~250ms of the switch and
are destroyed with the cover. Turning off **Slide animation** in preferences
removes them entirely and everything else keeps working.

### Why hide the shell's panel indicator instead of removing it?

Because it could not be put back. `WorkspaceIndicators` is a module-private
`const` in `panel.js` — not exported, not reachable, not constructible from an
extension. A destroyed one is gone for the rest of the session, so the panel
would be left permanently altered by an extension the user disabled.

Hiding it and inserting ours at index 0 means `disable()` destroys ours, the
original becomes the first child again, and `show()` restores the panel exactly
as it was found.

### Why does it set a property on `Meta.Window` objects?

To tell "the extension parked this window" from "the user minimized it". Without
that distinction, unloading would un-minimize windows the user had minimized
themselves.

The key is a namespaced symbol, `Symbol.for('workspace-islands.hidden')`, so it
cannot collide with a plain property or with another extension's. It is removed
when the window is restored, and `disable()` restores every window it set it on.

There is a second one, `Symbol.for('workspace-islands.placement')`, holding which
monitor and workspace the window was on. It is there for the opposite reason: it
*has* to outlive the extension. The shell tears extensions down and builds them
back up more often than you would think — every screen lock does it — and the
window is the only thing in reach that survives that. Unlike the first, it is
never removed, because inert data under a private key has no consequence, and it
dies with the window either way.

### Why is `version` missing from `metadata.json`?

Because the [guide](https://gjs.guide/extensions/overview/anatomy.html) says not
to set it:

> This field **SHOULD NOT** be set by extension developers. The GNOME Extensions
> website will override this field and GNOME Shell may automatically upgrade or
> downgrade an extension if the `version` field is set.

The user-visible string lives in `version-name`, which is what the Extensions app
displays. CI enforces both — the absence of one, the documented pattern of the
other — and refuses to publish a release whose tag disagrees with it.

### Is everything cleaned up when it unloads?

Yes, with one documented exception that cannot be reached from outside.

Every widget, signal and main loop source created is undone in `disable()`,
including the overview views — clearing the injections restores
`_updateWorkspacesView`, and asking each display to rebuild destroys what the
extension built. The swipe trackers use `SwipeTracker.destroy()`, the shell's own
teardown.

The exception: `ScrollGesture` is connected upstream with a plain `connect` whose
handler id is discarded, so nothing can disconnect it afterwards. Disabling the
tracker before destroying it is what makes that leftover inert — every gesture
returns `EVENT_PROPAGATE` when the tracker is disabled. It is written down in both
modules rather than left as a silent gap.

### What happens when a GNOME update moves one of these seams?

Something stops working, and the rest keeps going. Every override checks that its
target exists before installing, logs a warning naming what it could not find,
and returns. A missing method costs a feature — the overview falls back to the
shell's own view, the gesture goes away — and never takes the session with it.

Where to look is not a mystery either: all of the seams live in `src/overview.js`
and `src/slide.js`, each with a comment saying why that seam and not another.

## Contributing

```bash
make install   # symlink src/ into GNOME's extension dir — edits apply live
make doctor    # check every precondition; run this first when something is off
make nested    # launch a nested session for testing
make logs      # follow gnome-shell logs
make pack      # build the installable bundle
```

Nested testing needs **Mutter Devkit**, a separate package:

```bash
sudo pacman -S mutter-devkit    # Arch / CachyOS
```

Add a **second virtual display** from the devkit UI before testing, or the extension has nothing to act on.

Three things that cost time if you do not know them:

- **Wayland has no `Alt+F2 → r`.** The shell cannot restart in place. Test nested, then log out and back in for a real session.
- **GJS caches ES modules for the life of the process.** Editing a file does not affect a running shell, even if you toggle the extension off and on — you need a fresh shell.
- **`--nested` was removed in GNOME 49.** Mutter Devkit replaced it, and `--wayland` alone is not a substitute: it tries to take over your session and dies with `EBUSY`.

`make install` and `make pack` are different installs. The first symlinks `src/` so edits apply live; the second builds a bundle you install as a copy. `make doctor` tells you which one you have.

## Deliberately not built

**Filtering the app switcher.** `AppSwitcher` is a module-private const built inline inside its popup's constructor; patching it means reimplementing that constructor. Instead, an outside un-minimize is treated as intent: pick a window from workspace 2 via Alt+Tab, the dash or a notification, and that monitor switches to workspace 2 and takes you there. Better behaviour than hiding it, at none of the risk.

**A panel menu for switching a monitor you are not on.** The indicator used to be its own panel button with a dropdown. It was dropped when the indicator moved into the Activities button: a second panel button is the most obvious tell that an extension is installed, and the shortcuts already cover the monitor you are working on. Switching a monitor you are *not* focused on is the only thing lost, and it is rare enough not to earn back the UI.

## License

GPL-2.0-or-later
