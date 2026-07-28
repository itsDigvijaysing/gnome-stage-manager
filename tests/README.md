# Tests

GNOME Shell extensions can't be loaded outside a running shell, but most of the
bugs in this one were never in the rendering code — they were in the group state
machine, the workspace bookkeeping and the show/hide state. That part is plain
JavaScript, so it can be exercised offline.

`build.mjs` copies the **real** `src/extension.js`, redirects its seven `gi://`
and `resource:///` imports to `stubs.mjs`, and re-exports the internal classes.
The copy is regenerated on every run, so these tests always run against the
live source rather than a fork of it.

```bash
make test          # or: node tests/build.mjs && node tests/run.mjs
```

Requires `node` (any version with ESM + `node:assert/strict`). Exits non-zero on
failure.

## What the stubs model

Two details matter, because getting them wrong makes tests pass for the wrong
reasons:

- **A controllable clock.** `GLib.timeout_add` / `source_remove` run against a
  fake `now`, so a test decides exactly when a timer fires. Timing-dependent
  bugs are otherwise untestable.
- **Deferred window signals.** The compositor delivers `minimize` /
  `unminimize` asynchronously. `FakeWindow` flips its state immediately but
  *queues* the signal until the test calls `deliver()`. Emitting synchronously
  would hide exactly the swap races worth testing.

Handlers and timers are reset between tests — a `MaximizeToWorkspace` left
connected by a failed assertion would otherwise also handle the next test's
events.

## What is not covered

Anything that needs real Clutter: actor layout, hit-testing, event bubbling,
window clones. Those still need the manual pass in `CLAUDE.md` — install, log
out/in, watch `journalctl --user -f -o cat /usr/bin/gnome-shell`, and toggle the
extension off/on to confirm `disable()` runs clean.
