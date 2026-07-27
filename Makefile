UUID    := workspace-islands@danielbernalo.github.io
SRC     := $(CURDIR)/src
TARGET  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: help schemas skills install uninstall enable disable doctor pack nested logs status

help:
	@echo "make doctor     check every precondition — run this first when something's off"
	@echo "make skills     fetch agent skills pinned in skills-lock.json"
	@echo "make schemas    compile gsettings schemas"
	@echo "make install    compile schemas + symlink src/ into GNOME's extension dir"
	@echo "make enable     add the uuid to enabled-extensions (linking is not enabling)"
	@echo "make disable    remove the uuid from enabled-extensions"
	@echo "make uninstall  remove the symlink"
	@echo "make nested     run Mutter Devkit for testing (needs mutter-devkit)"
	@echo "make logs       follow gnome-shell logs"
	@echo "make status     show install + enable state"

# Agent skills are fetched, not vendored.
#
# `.agents/` is gitignored on purpose: the skill under it comes from
# tazztone/skills-server, which is public but declares no licence — and with no
# licence the default is all rights reserved, so redistributing it inside a
# GPL repository is not something to do casually. The lockfile records where it
# came from and at which commit; this target brings it back.
#
# It also re-applies one local patch. Upstream links its own reference files
# through absolute file:/// paths under the author's home directory, which
# resolve on exactly one machine.
skills:
	@python3 -c "$$SKILLS_SCRIPT"

define SKILLS_SCRIPT
import hashlib, io, json, pathlib, re, sys, tarfile, urllib.request

root = pathlib.Path('$(CURDIR)')
lock = json.loads((root / 'skills-lock.json').read_text())

for name, entry in lock['skills'].items():
    repo, ref = entry['source'], entry['ref']
    inner = str(pathlib.PurePosixPath(entry['skillPath']).parent)

    print('  %s <- %s@%s' % (name, repo, ref[:8]))

    url = 'https://codeload.github.com/%s/tar.gz/%s' % (repo, ref)
    with urllib.request.urlopen(url) as response:
        blob = response.read()

    target = root / '.agents' / 'skills' / name
    extracted = 0

    with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
        for member in tar.getmembers():
            parts = pathlib.PurePosixPath(member.name).parts[1:]
            prefix = pathlib.PurePosixPath(inner).parts

            if not member.isfile() or parts[:len(prefix)] != prefix:
                continue

            out = target.joinpath(*parts[len(prefix):])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(tar.extractfile(member).read())
            extracted += 1

    if not extracted:
        raise SystemExit('  nothing matched %s in the archive' % inner)

    skill = target / 'SKILL.md'
    digest = hashlib.sha256(skill.read_bytes()).hexdigest()

    if digest != entry['computedHash']:
        raise SystemExit(
            '  hash mismatch: locked %s, got %s\n'
            '  upstream moved under the pinned ref, which should not happen'
            % (entry['computedHash'][:12], digest[:12]))

    # Re-apply the local patch. See "patched" in skills-lock.json.
    text = skill.read_text()
    before = text.count('file:///')
    text = re.sub(r'file:///\S*?/skills/%s/references/' % name, 'references/', text)

    note = ('<!--\n'
            'Locally patched by `make skills`: upstream links its own reference\n'
            'files through absolute file:/// paths under the author home directory,\n'
            'which resolve on exactly one machine. Rewritten relative to this file.\n'
            '-->\n\n')

    if 'Locally patched' not in text:
        text = text.replace('# GNOME Shell Extensions', note + '# GNOME Shell Extensions', 1)

    skill.write_text(text)

    link = root / '.claude' / 'skills' / name
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(pathlib.Path('../../.agents/skills') / name)

    print('  %d files, hash verified, %d absolute links rewritten' % (extracted, before))
endef
export SKILLS_SCRIPT

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
	@if [ -L "$(TARGET)" ]; then echo "  OK   installed (symlink, live from src/)"; \
	  elif [ -d "$(TARGET)" ]; then echo "  OK   installed (bundle — edits to src/ will NOT apply)"; \
	  else echo "  FAIL not installed              -> make install"; fi
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

# The bundle is a flat zip: every module at the root, schemas/ holding only the
# XML — the shell compiles it at install time — plus the licence, because what
# a user downloads should carry the terms it ships under.
#
# Built with python rather than `gnome-extensions pack` or `zip`. The first
# lives in the gnome-shell package, so a CI runner would have to install a
# desktop to produce an archive; the second is simply absent on plenty of
# machines, which is how this target was broken before. python3 is already a
# dependency of the targets above.
#
# Deterministic on purpose: fixed timestamps and sorted entries, so the same
# tree always produces the same bytes and a release can be reproduced.
pack: schemas
	@python3 -c "$$PACK_SCRIPT"

define PACK_SCRIPT
import pathlib, zipfile

root = pathlib.Path('$(CURDIR)')
src = root / 'src'
out = root / '$(UUID).shell-extension.zip'

members = sorted(
    p for p in src.rglob('*')
    if p.is_file() and p.name != 'gschemas.compiled')

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for path in members:
        info = zipfile.ZipInfo(str(path.relative_to(src)), (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, path.read_bytes())

    licence = zipfile.ZipInfo('LICENSE', (1980, 1, 1, 0, 0, 0))
    licence.compress_type = zipfile.ZIP_DEFLATED
    licence.external_attr = 0o644 << 16
    z.writestr(licence, (root / 'LICENSE').read_bytes())

modules = {p.name for p in src.glob('*.js')}
packed = set(z.namelist())
missing = sorted(modules - packed)
if missing:
    raise SystemExit('MISSING FROM BUNDLE: ' + ', '.join(missing))

print('  packed %s' % out.name)
print('  %d js modules, %d files' % (len(modules), len(packed)))
endef
export PACK_SCRIPT
