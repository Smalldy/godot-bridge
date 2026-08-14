# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.2]: https://github.com/Smalldy/godot-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Smalldy/godot-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Smalldy/godot-bridge/releases/tag/v0.1.0
