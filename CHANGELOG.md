# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-10-24

### Fixed

- **eval no longer deadlocks under the local debugger (issue #13).** `godot_run_project` now starts **without** `-d` by default, so `godot_command eval` compiles user code without entering the interactive `debug>` prompt; a syntax error still reports its message and file:line in the captured output. `debug:true` is now explicitly **diagnostic mode**: the instance runs with the local debugger, the interaction server detects diagnostic mode from the `GODOT_BRIDGE_DEBUGGER=1` environment variable the bridge sets (an argv check alone cannot work: Godot consumes `-d` before `OS.get_cmdline_args()`, measured on 4.7.2) and **refuses eval** (no `reload()`) with a `next` step, and the bridge keeps a stdin pipe so that a detected `debug>`/`Debugger Break` writes exactly one `quit` (never `continue`), waits 3 s and then terminates the instance it started. The outcome is classified **by exit code, not by speed**: exit 0 → `diagnosis: "debugger-quit"`; any non-zero code → `diagnosis: "debugger-trap"` with `exitCode` and `crash: true`; still running after 3 s → `debugger-trap` with `killed: true`; all three carry a `debuggerTrace` (break reason, `*Frame N` frames with `file:line`, ≤4 KB tail). This is deliberately honest: on Godot 4.7.2-stable win64, writing `quit` exits in ~38 ms with **3221225477 (0xC0000005, ACCESS_VIOLATION)** and a C++ backtrace, so that run is a crash trap rather than a graceful exit. Measured baseline (minimal project + syntax-error script): no `-d` exits in ~372 ms with `SCRIPT ERROR … at: GDScript::reload`; `-d` with stdin at EOF prints **12089** break/prompt lines in 3 s (1.78 MB, ~590 KB/s) and must be killed (the issue #13 loop); `-d` with a stdin pipe prints one break/prompt (2.4 KB) because the debugger waits for input. `godot_command eval` timeouts now answer `{ error: "bridge timeout", diagnosis: "unresponsive", next }`, `godot_ping` reports `responsive: false` when the port accepts a connection but never answers instead of `game_running: false`, and an oversized `user://logs/godot.log` gets a warning (never deleted). Regression tests: `scripts/test/eval-guard.test.mjs` (self-contained, `node --test`) and `scripts/test/eval_guard.gd` (`godot_run_headless --script`).

- **The diagnostic-mode eval guard now actually fires (issue #13 follow-up).** The first cut sniffed `OS.get_cmdline_args()` for `-d`; Godot consumes engine flags, so on a real spawn that check was dead code and `eval` still reached `reload()` and fell into `debug>` (end-to-end run on 4.7.2: `Debugger Break, Reason: 'Parser Error…'`, then a `bridge timeout`). The bridge now passes `GODOT_BRIDGE_DEBUGGER=1` in the spawn environment, the server reads it (`is_local_debugger(args, debugger_flag)`), and a trap that still slips through is reported as `diagnosis: "debugger-trap"` with `debuggerTrace` instead of a bare timeout. Tests cover the env channel on both sides.

## [0.2.0] - 2026-10-01

### Added

- **`Godot engine path` is now editable in the GUI.** The bundle ships a browser half (`client/client.js`, declared through `dsh.client` in the manifest) that registers this bundle's configuration section — the keyed slot `plugins.bundle.config`, keyed by the package name — so the `godot-bridge` card on the Plugins page shows the path field between its description and its row list, with a **Save** and a **Reset to default** for a path this profile overrides. (The per-row slot `plugins.row.config`, keyed `<package name>#<row id>`, would put the same form one level deeper behind a Configure control on the row; it becomes the right slot once a bundle has several independently configurable rows, which this one does not.) A save travels the same road as the rest of DSH's settings and lands on the same `cordis.patch.yml` row `godot_set_engine_path` writes, so the field, the tool, and a hand-written `config:` block are three views of one value — and a change applies without a restart. Switching that row off withdraws the section with it, because the browser half belongs to that row. This closes the 0.1.8 known limitation below.
- `npm run check` now verifies the browser half as well, so the class of mistake that leaves a bundle without its form fails the build instead of failing silently: the `dsh.client` declaration (its allowed members, `platform: 'web'`, string-array `inject`/`external`, boolean `immediately`), an `exports["./client"]` target that exists and is shipped by `files`, a `window.__ModuleLoader__.load({ id })` registration whose id is the package name, the `slots` service declaration, every `require()` specifier against the web client's platform seed modules plus `dsh.client.external`, a `plugins.bundle.config` key against this bundle's package name, and a `plugins.row.config` key against the rows the patch declares. Slot keys and module requests are read from code, so a comment cannot satisfy a check.

### Changed

- The browser half is inert where DSH cannot host it: 0.1.6–0.1.x already declares these slots but has no settings-form service to read the value through, so the registration sits behind `ctx.inject(['configForms'], …)` and those runtimes keep exactly the previous behaviour (no GUI field, `godot_set_engine_path` and `settings.yaml` as before). A runtime that never scans `dsh.client` (anything older than 0.1.0-rc.7) ignores the new manifest member.

## [0.1.8] - 2026-09-30

### Fixed

- The plugin could not load at all on DSH 0.2.x when installed as a `link:` dependency: the launcher's runtime resolution routes `@deepseek-ai/*` to the installation only for names a linked package declares in its own `peerDependencies` (it reads `peerDependencies` keys, not `dependencies`), and godot-bridge declared none — so `import '@deepseek-ai/dsh-tools'` failed with `ERR_MODULE_NOT_FOUND` and none of the seventeen `godot_*` tools registered. The manifest now declares `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`.
- `godotPath` no longer disappears on DSH 0.2.x: `@deepseek-ai/dsh-settings` dropped `register`, so the settings section silently degraded to a warning and `godot_set_engine_path` always answered that the settings service was unavailable.
- An engine path configured before the 0.1.x → 0.2.x upgrade is carried over automatically instead of silently falling back to `godot` on PATH (typically a version-manager shim, i.e. a different build than the one configured). See the migration note under **Changed**.

### Changed

- Configuration model: `godotPath` is a `.volatile()` field of the plugin's Config, so it appears on the plugin settings page and is read live (volatile fields are updated in place, without remounting the plugin). Writes persist through `ctx.configEditor.edit(...)` into the active profile's `cordis.patch.yml` and hot-recompose — no restart.
- `godot_set_engine_path` now checks that the target exists before writing and reports where it persisted: `persisted: 'profile-patch'` on DSH 0.2.x, `'settings'` on the legacy path.
- Legacy runtimes stay supported: on 0.1.6–0.1.x, where `settings.register` still exists, the plugin keeps using it (the `@deepseek-ai/dsh-tools` peer range is `>=0.1.6-0`). `peerDependenciesMeta.optional` keeps pnpm from installing harness packages from the registry.
- `settings.yaml` migration: DSH 0.2 imports leftover sections by plugin entry id, and this plugin's row id is `tool-godot-bridge`, so a `godot-bridge:` section written on 0.1.x is not carried over. When this runtime has no configured path, the plugin now reads that section and writes the recorded value back through the same profile-patch path as `godot_set_engine_path`, so the engine build configured before the upgrade is used again without re-entering it. An already-configured value is never overwritten, and a recorded path that no longer exists on disk is ignored (that case keeps the PATH fallback and its warning). The restore runs once per plugin load and is best-effort: a rejected write leaves the PATH fallback in place and logs a warning, and never disables a tool.

### Added

- `npm run check` — `scripts/check-plugin-contract.mjs`, a dependency-free static contract check: every bare `@deepseek-ai/*` import must be declared in `peerDependencies`/`dependencies`, `dsh.bundle.patch` must exist and reference the package, `main`/`exports` targets must exist and be covered by `files`, and the entry point must export `name`/`apply` without an `export default`.
- `scripts/diagnose-dsh-resolution.mjs` — a re-runnable diagnostic for the launcher's runtime resolution (bundle layers, skipped bundles, linked roots, per-import result, `--expect ok|fail`); development-only and never published.

### Documentation

- README: new "DSH 0.2+ compatibility and troubleshooting" section (resolution rules, the `link:` peer requirement, a symptom table, the `dsh plugin allow-version` fallback, verification commands) plus corrected config-location wording.
- install: a `link:` local-development section, a rewritten Config section (volatile field, profile-patch write path, legacy fallback, `settings.yaml` migration note), and maintenance steps for the check and diagnostic scripts.
- ARCHITECTURE: new "Dependency contract and runtime resolution" section with its layer diagram.

### Known limitation

- `godotPath` has **no GUI form field** on DSH 0.2. The Plugins page renders a row's configuration form only when that plugin ships a client component registering the keyed slot `plugins.row.config`; no built-in package registers it, and godot-bridge ships no client entry. The Host side is unaffected — `settings.describe()` still projects the field for the `tool-godot-bridge` row, and `godot_set_engine_path` (or a `config:` block on that row) sets it. Tracked as a separate feature request.

## [0.1.7] - 2026-09-07

### Fixed

- Stale autoload was silently defeating port routing: a project whose `autoload/mcp_interaction_server.gd` predated `GODOT_BRIDGE_PORT`/`get_instance_info` kept binding 9090 no matter what port `godot_run_project` requested — so a `port=9092` run reported success but every later `godot_command`/`godot_screenshot` could only find 9090 (issues #4). `ensureInteractionAutoload` now overwrites an out-of-date autoload with the vendored version (the file is plugin-managed infrastructure) and reports `upgraded` when it had to.
- `godot_ping` and error messages report the real probed port instead of a hardcoded `127.0.0.1:9090`.
- `writeProjectFile` scopes its fs policy to the target project directory instead of the session workspace, so autoload/project-file writes are legal for projects outside the workspace.
- Added a `sanitizeLossless` guard at every tool return so a stray `undefined`/`NaN` value degrades to a logged, fixed value instead of a silent `value is not lossless JSON` failure.

## [0.1.6] - 2026-09-01

### Added

- Instance ownership for `godot_run_project`: it probes the port first and ADOPTS an already-running instance of the same project (returns `external: true`) instead of spawning a duplicate that fails to bind — the exact scenario where a user starts a scene in the editor and the LLM then runs the project, which previously produced a silent mis-attach and an orphaned second process.
- A different project on the port triggers an automatic fallback to 9091+ (or the caller's `port` argument) instead of colliding.
- `mcp_interaction_server.gd` now reads `GODOT_BRIDGE_PORT` / `GODOT_BRIDGE_TOKEN` and exposes `get_instance_info` (pid/port/token/project) — the identity basis for ownership detection.
- `godot_stop_project` refuses to terminate adopted (user/editor-launched) instances and explains how to stop safely (F8 in the editor / in-game quit); the plugin never kills processes it did not start. New `godot-bridge:instance-ownership` system-prompt section with the same rule, also forbidding pwsh process-kill workarounds that would take the whole editor down.

### Fixed

- Compatibility with dsh-settings ≥ 0.1.2-alpha: the removed `settingsNamespace` export is gone from the plugin (the plain namespace string is passed to `ctx.settings.register`); settings and tool registration are wrapped defensively so future API drift degrades with a warning instead of failing the host boot.

## [0.1.5] - 2026-08-19

### Added

- `godot_run_headless` tool: bounded headless scene/logic/test runs through the unconfined subprocess service (`godot --headless --path <project> [--quit-after N] [--script <g>]` with a timeout kill), replacing the crash-prone practice of running `godot --headless` through a sandboxed pwsh/bash shell.

### Changed

- `godot_headless_op` / `godot_validate_script` / `godot_export_project` now attach a crash `diagnosis` (`sandbox-crash`, high/low confidence, actionable hint) instead of handing back raw stderr alone, so a sandbox crash can no longer masquerade as a project bug.
- New `godot-bridge:launch-channel` system-prompt section: Godot must always be started through the godot_* tools (unconfined subprocess), never through pwsh/bash (file-sandboxed, signal 11).
- `godot_run_project` description points at `godot_run_headless` for non-interactive headless runs.

### Fixed

- `godot_run_headless` returned `note: undefined` on the normal path; the DSH tool layer rejects any `undefined` property ("value is not lossless JSON") and discarded the entire result. `note` is now only present on timeout, and `exit_code` is normalized so every return field is lossless JSON.
- `godot_validate_script` error entries now use `null` (not `undefined`) for missing file/line locations.

## [0.1.4] - 2026-08-16

### Fixed

- Restore the `timer` injection dropped in 0.1.3: `ctx.timeout()` is a mixin of the timer service whose getter reads `ctx.timer`, so its removal broke `godot_run_project` / `godot_command` / `godot_screenshot` with `cannot get property "timer" without inject`.

## [0.1.3] - 2026-08-15

### Added

- `godot_set_engine_path` tool: the model asks the user for their Godot executable and persists it into settings (schema- and existence-validated, hot-reloaded — no restart), closing the "no engine configured" guidance loop.

### Changed

- `godotPath` is now a user-facing settings value (the Web plugin-config page or the `godot-bridge:` section of `settings.yaml`), not a `cordis.patch.yml` row config; the plugin author no longer presets a path (Godot is a portable exe that can live anywhere).
- Godot executable resolution order: per-tool `godot_path` argument → the `godotPath` setting → the `godot` command on PATH. Nothing to configure when `godot` is on PATH.
- Existence validation moved from an `apply`-time `throw` (which failed the whole fiber) to the settings `validate` hook, so a bad path can no longer disable the pure-file tools.

### Fixed

- Tool descriptions no longer mislabel the config location as `$DSH_HOME/settings.yaml`; they now point at the settings section the code actually reads.

### Removed

- Redundant `timer` injection and `console.log` noise (now `ctx.logger`).

## [0.1.2] - 2026-08-15

### Fixed

- The update notice now reliably reaches the model: `systemPrompt` is injected (was a lazy `ctx.get` that could miss the service) and the notice text is an explicit instruction to inform the user, so the model surfaces "update available: installed X, latest Y" in every session.
- `godot_ping` reports `plugin_version` / `latest_version` / `update_available` for on-demand checks.

## [0.1.1] - 2026-08-15

### Added

- Boot-time update notice: a best-effort version check against the repo's `main`-branch `package.json` (`raw.githubusercontent.com`, 5 s timeout, silent on failure/offline). When a newer release exists it registers a system-prompt section; the `repository` field in `package.json` redirects the check for forks.

### Fixed

- `godot_command`'s `timeout_ms` was a no-op: the one-shot node bridge hard-capped at 20 s. The timeout is now threaded through as `argv[3]` (fallback 20 s), so `godot_ping`, `godot_run_project`'s readiness poll, and async commands honor their timeouts.

### Changed

- Dropped stale headless-script fallback candidates (`<project>/tools/godot-bridge/`, `../godot-mcp/src/scripts/`) from the pre-bundle deployment; the module-relative copy is the only source.

## [0.1.0] - 2026-08-15

Initial release — a standard DSH bundle that replaces the godot-mcp MCP server with native agent tools.

### Added

- Fifteen `godot_*` tools:
  - process: `godot_run_project` / `godot_stop_project` / `godot_get_debug_output` / `godot_ping`
  - runtime control: `godot_command` (every interaction-server command), `godot_screenshot`
  - headless: `godot_headless_op` (16 ops) / `godot_validate_script`
  - project editing: `godot_set_project_setting` / `godot_manage_autoloads` / `godot_manage_input_map` / `godot_manage_export_presets` / `godot_create_script` / `godot_create_project` / `godot_export_project`
- Standard DSH bundle form: `defineTool` from `@deepseek-ai/dsh-tools` + `ctx.tools.register`; `dsh.bundle` manifest installs with `dsh plugin --profile web add github:Smalldy/godot-bridge`.
- Vendored game-side assets: `mcp_interaction_server.gd` (in-game TCP autoload), `godot_operations.gd`, `validate_script.gd`.
- Correct Godot 4 keycodes in `godot_manage_input_map` (fixes godot-mcp's Godot 3 baseline bug).
- Bilingual documentation (README / install / ARCHITECTURE / COVERAGE) incl. install and uninstall guides; `cordis.patch.yml` included in published `files`.

[0.2.0]: https://github.com/Smalldy/godot-bridge/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/Smalldy/godot-bridge/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Smalldy/godot-bridge/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Smalldy/godot-bridge/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Smalldy/godot-bridge/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Smalldy/godot-bridge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Smalldy/godot-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Smalldy/godot-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Smalldy/godot-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Smalldy/godot-bridge/releases/tag/v0.1.0
[0.2.1]: https://github.com/Smalldy/godot-bridge/compare/v0.2.0...v0.2.1
