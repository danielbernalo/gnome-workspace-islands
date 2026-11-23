# Changelog

Every release of Workspace Islands, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions are the
`version-name` in `src/metadata.json`.

## [0.1.3] - 2026-11-23

### Added

- GNOME Shell 51 support. ([#22](https://github.com/danielbernalo/gnome-workspace-islands/pull/22))
- Unit tests for the window model, run by `make test` and on every pull request. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))

### Fixed

- Only windows GNOME can minimize enter a virtual workspace. The desktop-icons window, docks and dialogs no longer take up a workspace, and no longer get marked as hidden while they are still on screen. ([#18](https://github.com/danielbernalo/gnome-workspace-islands/issues/18), [#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- A window you minimized yourself stays minimized when you switch workspaces, when the screen locks and when the extension is disabled. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- Unplugging a secondary monitor no longer leaves its parked windows minimized and missing from Alt+Tab and the overview. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- Lowering the workspace count no longer leaves the windows it folds onto the workspace you are on hidden. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- Dynamic mode keeps every window on its own workspace across a lock, keeps an empty spare after you turn it on, and keeps saved app rules. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- Saving no longer erases the arrangement of monitors that are not plugged in. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- A switch-to-N shortcut assigned in preferences works immediately, without disabling and re-enabling the extension. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- Switching workspaces on a secondary monitor keeps focus on that monitor, so the next shortcut still acts there. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- The slide animation stacks windows in their real order, does not show windows you minimized, and recovers from a gesture interrupted by a dialog or a second monitor. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- Overview: the right page is centred in right-to-left languages, the active thumbnail accepts drops, clicking a neighbouring page switches to it, and a swipe is no longer lost when the overview closes mid-animation. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- Super + mouse wheel on a secondary monitor respects the same rate limit as on the primary. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- No touchpad handler is left connected after the extension is disabled. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))
- Windows no longer jump when the overview opens or closes on a secondary monitor; the thumbnail strip fades in and its thumbnails have rounded corners. ([#16](https://github.com/danielbernalo/gnome-workspace-islands/pull/16))
- A malformed saved state no longer stops the extension from loading on every login. ([#23](https://github.com/danielbernalo/gnome-workspace-islands/pull/23))
- Two small leaks: the panel dots after a panel rebuild, and a settings watcher in preferences. ([#23](https://github.com/danielbernalo/gnome-workspace-islands/pull/23))

### Changed

- CI and release run on current GitHub Actions pinned by commit, with a read-only token for checks. ([#23](https://github.com/danielbernalo/gnome-workspace-islands/pull/23))
- Comments in the code are kept to one line, and only where the code cannot say it. ([#24](https://github.com/danielbernalo/gnome-workspace-islands/pull/24))

## [0.1.2] - 2026-07-29

### Added

- Dynamic virtual workspaces: each secondary monitor can grow and shrink its workspaces like GNOME's own, with the `Dynamic workspaces` switch in preferences. ([#10](https://github.com/danielbernalo/gnome-workspace-islands/pull/10))

### Fixed

- In dynamic mode, the workspace you were on is restored after a lock instead of dropping you on workspace 2. ([#13](https://github.com/danielbernalo/gnome-workspace-islands/pull/13))

## [0.1.1] - 2026-07-28

### Added

- Super + mouse wheel switches workspaces on a secondary monitor. ([#9](https://github.com/danielbernalo/gnome-workspace-islands/pull/9))

### Fixed

- Suspend, lock and monitor hotplug keep every window on the workspace it was on, instead of piling them onto one. ([#9](https://github.com/danielbernalo/gnome-workspace-islands/pull/9))
- Saved state is keyed by the monitor's connector, so a display that comes back gets its own arrangement. ([#9](https://github.com/danielbernalo/gnome-workspace-islands/pull/9))
- The install instructions are in an order that works. ([#6](https://github.com/danielbernalo/gnome-workspace-islands/pull/6))

## [0.1.0] - 2026-07-27

First release.

- Independent virtual workspaces on every secondary monitor, without touching the primary or GNOME's own workspaces.
- Keyboard shortcuts to switch workspaces and move the focused window, all rebindable.
- A slide animation and the workspace switcher pill on the monitor that changed.
- Three-finger touchpad swipes on a secondary monitor and in the overview.
- The overview scrolls through a secondary monitor's workspaces, with a thumbnail strip and drag and drop of windows between them.
- The panel's workspace dots follow the monitor you are working on.
- Alt+Tab leaves out windows parked on other workspaces.
- Which workspace each monitor was on, and where each app belongs, survive a logout.

[0.1.3]: https://github.com/danielbernalo/gnome-workspace-islands/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/danielbernalo/gnome-workspace-islands/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/danielbernalo/gnome-workspace-islands/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/danielbernalo/gnome-workspace-islands/releases/tag/v0.1.0
