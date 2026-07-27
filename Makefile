UUID    := workspace-islands@danielbernalo.github.io
SRC     := $(CURDIR)/src
TARGET  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: help schemas install uninstall enable disable doctor pack nested logs status

help:
	@echo "make doctor     check every precondition — run this first when something's off"
	@echo "make schemas    compile gsettings schemas"
	@echo "make install    compile schemas + symlink src/ into GNOME's extension dir"
	@echo "make enable     add the uuid to enabled-extensions (linking is not enabling)"
	@echo "make disable    remove the uuid from enabled-extensions"
	@echo "make uninstall  remove the symlink"
	@echo "make nested     run Mutter Devkit for testing (needs mutter-devkit)"
	@echo "make logs       follow gnome-shell logs"
	@echo "make status     show install + enable state"

schemas:
	glib-compile-schemas $(SRC)/schemas

install: schemas
	@if [ -e "$(TARGET)" ] && [ ! -L "$(TARGET)" ]; then \
		echo "ERROR: $(TARGET) exists and is not a symlink. Refusing to touch it."; \
		exit 1; \
	fi
	@rm -f "$(TARGET)"
	@ln -s "$(SRC)" "$(TARGET)"
	@echo "linked $(TARGET) -> $(SRC)"

uninstall:
	@if [ -L "$(TARGET)" ]; then rm -f "$(TARGET)"; echo "unlinked $(TARGET)"; \
	else echo "nothing to unlink (not a symlink)"; fi

# Linking is not enabling. `gnome-extensions enable` refuses a uuid the running
# shell has never seen, so the list is edited directly instead.
#
# dconf, not gsettings: in some shells gsettings silently falls back to an
# in-memory backend, reporting schema defaults on read and dropping writes.
ENABLED_KEY := /org/gnome/shell/enabled-extensions

enable:
	@python3 -c "import ast,subprocess as s; k='$(ENABLED_KEY)'; u='$(UUID)'; \
c=s.run(['dconf','read',k],capture_output=True,text=True).stdout.strip(); \
l=ast.literal_eval(c) if c else []; \
l.append(u) if u not in l else None; \
s.run(['dconf','write',k,repr(l)]); \
print('enabled: '+u+'  (log out and back in for a real session)')"

disable:
	@python3 -c "import ast,subprocess as s; k='$(ENABLED_KEY)'; u='$(UUID)'; \
c=s.run(['dconf','read',k],capture_output=True,text=True).stdout.strip(); \
l=ast.literal_eval(c) if c else []; \
l=[x for x in l if x!=u]; \
s.run(['dconf','write',k,repr(l)]); \
print('disabled: '+u)"

# Wayland cannot restart the shell in place, so testing happens in a nested
# session. Two things changed in GNOME 49/50 and both cost time to rediscover:
#
#   1. `--nested` was removed in 49.beta1. Its replacement is Mutter Devkit,
#      a separate package (`mutter-devkit`) shipping /usr/lib/mutter-devkit.
#   2. `--wayland` alone does NOT run nested — it tries to take over the
#      session and dies with EBUSY. `--virtual-monitor` forces that same mode.
#
# Devkit spawns virtual displays from its own UI, which is what makes this
# extension testable without a second physical monitor.
DEVKIT := /usr/lib/mutter-devkit

nested:
	@if [ ! -x "$(DEVKIT)" ]; then \
		echo "mutter-devkit is not installed — nested testing needs it."; \
		echo "  sudo pacman -S mutter-devkit    # Arch / CachyOS"; \
		echo ""; \
		echo "Then add a second virtual display from the devkit UI: this"; \
		echo "extension only acts on secondary monitors."; \
		exit 1; \
	fi
	dbus-run-session -- gnome-shell --devkit --wayland

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

status:
	@echo "symlink:"; ls -ld "$(TARGET)" 2>/dev/null || echo "  not installed"
	@echo "shell:"; gnome-extensions info $(UUID) 2>/dev/null || echo "  unknown to gnome-shell"

# Every precondition that has silently broken a test run at least once.
doctor:
	@echo "── preconditions ──────────────────────────────"
	@if [ -L "$(TARGET)" ]; then echo "  OK   symlink installed"; \
	  else echo "  FAIL symlink missing            -> make install"; fi
	@if dconf read $(ENABLED_KEY) | grep -q "$(UUID)"; then echo "  OK   listed in enabled-extensions"; \
	  else echo "  FAIL not enabled                -> make enable"; fi
	@if [ "$$(dconf read /org/gnome/mutter/workspaces-only-on-primary)" = "true" ]; then \
	    echo "  OK   workspaces-only-on-primary=true"; \
	  else echo "  FAIL workspaces-only-on-primary is not true -> dconf write /org/gnome/mutter/workspaces-only-on-primary true"; fi
	@if dconf read $(ENABLED_KEY) | grep -q "paperwm"; then \
	    echo "  FAIL PaperWM enabled — it forces the setting off"; \
	  else echo "  OK   PaperWM not enabled"; fi
	@if [ -x "$(DEVKIT)" ]; then echo "  OK   mutter-devkit present"; \
	  else echo "  WARN mutter-devkit missing      -> sudo pacman -S mutter-devkit"; fi
	@echo "───────────────────────────────────────────────"
	@echo "Note: gsettings may report schema defaults instead of real values."
	@echo "      dconf is the source of truth."

# `gnome-extensions pack` ships extension.js, prefs.js, metadata.json,
# stylesheet.css and schemas/ — and nothing else. Every other module has to be
# named with --extra-source. It does not warn about the ones you forget; it
# produces a bundle that throws on the first import instead.
#
# Computed from the directory rather than listed, so a module added later
# cannot be silently left out of a release.
EXTRA_SOURCES := $(filter-out extension.js prefs.js,$(notdir $(wildcard $(SRC)/*.js)))

pack: schemas
	@cd $(SRC) && gnome-extensions pack --force -o $(CURDIR) \
	  $(foreach f,$(EXTRA_SOURCES),--extra-source=$(f)) .
	@echo "packed $(UUID).shell-extension.zip"
	@python3 -c "import zipfile,sys; \
z=zipfile.ZipFile('$(CURDIR)/$(UUID).shell-extension.zip'); \
missing=[f for f in '$(notdir $(wildcard $(SRC)/*.js))'.split() if f not in z.namelist()]; \
sys.exit('MISSING FROM BUNDLE: '+', '.join(missing)) if missing else \
print('  %d js modules bundled' % len([n for n in z.namelist() if n.endswith('.js')]))"
