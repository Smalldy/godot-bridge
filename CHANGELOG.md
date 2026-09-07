# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.7]: https://github.com/Smalldy/godot-bridge/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Smalldy/godot-bridge/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Smalldy/godot-bridge/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Smalldy/godot-bridge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Smalldy/godot-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Smalldy/godot-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Smalldy/godot-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Smalldy/godot-bridge/releases/tag/v0.1.0
