# Contributing

Thanks for looking. This is a young project — the most valuable thing you can
send right now is a good bug report.

## Reporting a bug

Open a [bug report](../../issues/new?template=bug_report.yml). The form asks
for GNOME version, session type, monitor layout and journal output because
without those three a maintainer is guessing, and guessing at a shell
extension usually means asking you to run things for a week.

Run `make doctor` first — it checks every precondition at once and rules out
the common causes in one command.

## Proposing a change

Open a [proposal](../../issues/new?template=feature_request.yml). The form
leads with the problem rather than the solution on purpose: a clearly stated
problem often has a better answer than the one either of us walked in with.

Read **Deliberately not built** in the README first. Some things were left out
for reasons that are written down; if you think a reason has stopped being
true, say so — that is a fine proposal.

## Sending code

**Open an issue first.** Not bureaucracy: this extension patches GNOME Shell
internals, and whether a change is a good idea usually depends on which seam it
lands on. Ten minutes in an issue can save an afternoon in a branch.

```bash
git checkout -b fix/short-description main
```

Branch names are `type/description` — `feat`, `fix`, `chore`, `docs`,
`refactor`, `perf`, `test`, `build`, `ci`, `revert` — lowercase, no spaces.

Commits follow [Conventional Commits](https://www.conventionalcommits.org):

```
fix(indicator): render the panel workspace dots
feat(overview): drag windows between virtual workspaces
docs: rewrite the README for people who want to use this
```

One commit per unit of work — something a reviewer can understand, and you can
revert, on its own. Not one commit per file type.

Then open a PR against `main` and add exactly one `type:*` label.

## Developing

```bash
make install   # symlink src/ into the extensions dir — edits apply live
make doctor    # check every precondition; run this first when something is off
make nested    # launch a nested session for testing
make logs      # follow gnome-shell logs
make pack      # build the installable bundle
```

Three things that cost time if you do not know them:

- **GJS caches ES modules for the life of the process.** Editing a file changes
  nothing in a running shell — not even if you toggle the extension off and on.
  You need a fresh shell every time.
- **Wayland has no `Alt+F2 → r`.** Test in `make nested`, then log out and back
  in for a real session.
- **`make install` and `make pack` are different installs.** The first
  symlinks, so edits apply live; the second installs a copy, so they do not.
  `make doctor` tells you which one you have.

There are no automated tests. What CI checks is that every module parses, the
schema compiles, metadata and schema agree, imports resolve, and the bundle
would contain every module. All five exist because each caught a real bug
during development. Everything about behaviour is verified by hand — say what
you did in the PR.

## Touching GNOME Shell internals

Most of this extension's risk lives in a handful of places where it patches,
overrides or replaces something private in GNOME Shell. Those are listed at the
top of `src/overview.js` and `src/slide.js`, each with the reasoning for why
that seam and not another.

If you add one:

- Say in a comment **why that seam**, and what happens when it moves.
- Degrade rather than throw. A missing method should cost a feature, not the
  session.
- Undo it in `disable()`. Anything left patched after unload is a bug that
  outlives the extension.

Two traps already documented in code, worth knowing before you spend a day on
either: a handler connected with `.bind(this)` in a constructor cannot be
overridden afterwards, and a disabled `SwipeTracker` is the only way to stop the
shell's own gestures from swallowing events.

## Code of Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
