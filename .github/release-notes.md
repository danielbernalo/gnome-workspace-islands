## Install

Download the `.zip` below, then:

```bash
gnome-extensions install --force workspace-islands@danielbernalo.github.io.shell-extension.zip
```

Now **log out and back in** — Wayland cannot reload the shell in place, and until
the session restarts the shell does not know the extension exists.

That is why enabling comes *after* the restart. Run it earlier and you get
`Extension … does not exist`, because you are asking a shell that has not looked yet:

```bash
gnome-extensions enable workspace-islands@danielbernalo.github.io
```

Check it came up:

```bash
gnome-extensions info workspace-islands@danielbernalo.github.io   # State: ACTIVE
```

Requires GNOME Shell 50 on Wayland, at least two monitors, and
`workspaces-only-on-primary` set to `true`. See the
[README](https://github.com/danielbernalo/gnome-workspace-islands#before-you-install)
for the full list.

The build is deterministic: `make pack` at this tag reproduces the archive
below byte for byte.

---
