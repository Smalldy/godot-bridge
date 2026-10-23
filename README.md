**English** | [中文](README.zh-CN.md)

# godot-bridge

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![Listed on DSH Directory](https://dsh.directory/badges/listed.svg)](https://dsh.directory/plugins/smalldy/godot-bridge)

Native **DeepSeek Harness (DSH)** plugin that launches and drives a running **Godot 4.x** game through its in-game TCP interaction server — replacing the [`godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) MCP server with first-class agent tools.

No MCP protocol, no Python server, no editor addon. The game side is untouched: `McpInteractionServer` (the `mcp_interaction_server.gd` autoload) already listens on `127.0.0.1:9090` and speaks newline-delimited JSON — godot-bridge speaks the same protocol natively from inside the DSH host.

## Tools

`godot_run_project` starts **without** the local debugger (`-d`) by default, so `godot_command eval` works normally. `debug:true` is **diagnostic mode**: the instance runs with the local debugger, the interaction server **refuses `eval`** (it learns this from the `GODOT_BRIDGE_DEBUGGER=1` environment variable the bridge sets at spawn — Godot consumes `-d` before `OS.get_cmdline_args()` can see it, measured on 4.7.2, so an argv check alone never fires) (a syntax error would otherwise enter the interactive `debug>` prompt and deadlock, issue #13), and a script error returns a `debuggerTrace` (break reason, `*Frame N` stack frames with `file:line`, ≤4 KB raw tail) plus a `next` step and ends that run. In diagnostic mode the bridge watches stdout for the debugger and writes exactly one `quit` (never `continue`), then classifies the outcome **by exit code**: exit 0 → `diagnosis: "debugger-quit"`; any non-zero code → `diagnosis: "debugger-trap"` with `exitCode` and `crash: true`; still running after 3 s → `debugger-trap` with `killed: true`. The classification is deliberately honest: on Godot 4.7.2-stable win64 writing `quit` exits in ~38 ms with **3221225477 (0xC0000005, ACCESS_VIOLATION)** and a C++ backtrace, so that run is reported as a crash trap, not as a graceful exit. Measured regression baseline (minimal project + syntax-error script): without `-d` the process exits in ~372 ms with `SCRIPT ERROR … at: GDScript::reload`; with `-d` and stdin at EOF it prints **12089** `Debugger Break`/`debug>` lines in 3 s (1.78 MB, ~590 KB/s) and must be killed — the issue #13 loop; with `-d` and a stdin pipe only one break/prompt appears (2.4 KB) because the debugger waits for input. To run code under the debugger, use `godot_run_headless --script`.

| Tool | Replaces (godot-mcp) | Purpose |
| --- | --- | --- |
| `godot_run_project` | `run_project` | Launch the project (`godot --path …`, **no local debugger by default**), wait for port 9090. `debug:true` = diagnostic mode (`-d`, eval disabled, script errors return `debuggerTrace`) |
| `godot_stop_project` | `stop_project` | Terminate the game process (tree-scoped kill) |
| `godot_get_debug_output` | `get_debug_output` | Incremental stdout/stderr of the launched process |
| `godot_command` | all `game_*` (~105) | Send any interaction-server command: `get_scene_tree`, `get_ui_elements`, `eval`, `get/set_property`, `call_method`, `click`, `key_press`, `screenshot`, `raycast`, `serialize_state`, `ui_*`, … |
| `godot_screenshot` | `game_screenshot` | Viewport capture as base64 PNG |
| `godot_ping` | — | Probe whether the game answers on 9090 (also reports installed/latest plugin version, and `responsive:false` when the port accepts but never answers) |
| `godot_set_engine_path` | — | Persist the Godot engine executable path into the plugin's config (the model asks the user for it, then saves it here; hot-reloaded — reports `persisted: 'profile-patch'` on DSH 0.2.x, `'settings'` on the legacy path) |
| `godot_headless_op` | `read_scene`, `modify_scene_node`, `remove_scene_node`, `attach_script`, `create_resource`, `save_scene`, `create_scene`, `add_node`, `get_uid`, `manage_scene_signals`, … | Headless static operations (`godot --headless --script godot_operations.gd`): 16 ops, no running game needed |
| `godot_run_headless` | — | Bounded **non-interactive** run of the project, a scene, or a test script (`godot --headless --path … [--quit-after N] [--script …]`) through the unconfined subprocess service; returns stdout/stderr and flags a sandbox-crash diagnosis |
| `godot_validate_script` | `validate_script` | Headless GDScript compile-check via `validate_script.gd` → `{valid, errors}` |
| `godot_set_project_setting` | `modify_project_settings`, `set_main_scene`, `manage_layers`, `manage_plugins`, `manage_translations` | Set a typed key in any project.godot section (`PackedStringArray(...)` / `Vector2i(...)` / bool / …) |
| `godot_manage_autoloads` | `manage_autoloads` | List / add / remove autoload singletons (`Name="*res://…"`) |
| `godot_manage_input_map` | `manage_input_map` | List / add / remove input actions — **correct Godot 4 keycodes** (fixes godot-mcp's Godot 3 baseline bug) |
| `godot_manage_export_presets` | `manage_export_presets` | List / add / remove export presets (`export_presets.cfg`) |
| `godot_create_script` | `create_script` | GDScript template (extends / class_name / method stubs / source) |
| `godot_create_project` | `create_project` / `create_csharp_script` | Project scaffold, optional Godot .NET `.csproj` |
| `godot_export_project` | `export_project` | Headless export (`--export-release` / `--export-debug <preset> <output>`) |

The remaining godot-mcp tools were implemented in the MCP server's own Node process: pure file/editor operations are covered by DSH's native file tools, while a handful carry **Godot-specific write logic** (`manage_input_map`, `manage_export_presets`, `modify_project_settings`, project/script templates) that a generic edit replaces only with format knowledge — see [COVERAGE.md](COVERAGE.md) for the full breakdown.

## How it works

```
DSH session
  └─ godot-bridge (Host plugin)
       ├─ godot_run_project ──────► subprocess.spawn(Godot -d --path <project>)
       ├─ godot_get_debug_output ─► collect-mode output (incremental offsets)
       └─ godot_command / godot_screenshot / godot_ping
            └─ subprocess.spawn(node -e <bridge> <command> <paramsJson>)
                 └─ TCP 127.0.0.1:9090 ◄── in-game McpInteractionServer autoload
```

- The in-game protocol (`{command, params, id}` + newline) is **identical** to godot-mcp, so the game side and any existing workflows keep working.
- Each command spawns a one-shot `node -e` bridge that connects, sends one line, prints the first response line, and exits. The game server is single-connection/single-command (`_busy`), so short-lived connections are a perfect fit.
- Spawning uses the harness's raw `subprocess` service (not the sandboxed shell executor), so Godot can write its `user://` files without the DSH file sandbox killing it (see Pitfalls).

## Requirements

- DeepSeek Harness (a session with a host runtime)
- A Godot 4.x project with the `McpInteractionServer` autoload registered. If your project does not have it yet, copy `plugin/mcp_interaction_server.gd` to the project root and register it as an autoload named `McpInteractionServer` (godot-mcp projects already have this). **`godot_run_project` also auto-installs it when missing** (copies the vendored file into `autoload/` and registers it in `project.godot`), so no manual setup is needed — and non-Godot projects are completely unaffected.
- `node` on PATH
- Godot executable — resolved in this order: the `godot_path` tool argument → the **`godotPath` plugin setting** (the config of the `tool-godot-bridge` row: the `Godot engine path` field on the godot-bridge card's Plugins page on DSH 0.2.x, the `godot_set_engine_path` tool, or the plugin settings section on 0.1.x) → the `godot` command on PATH. Nothing to configure when `godot` is on PATH; otherwise set your engine path (the plugin author does not preset it — Godot is a portable exe that can live anywhere). Use the **real exe full path**, never a version-manager shim (see Pitfalls).

## Install

**Recommended — one command** (requires the `dsh` CLI):

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` is a pnpm forwarder: it installs the package into the profile's `node_modules` and — because the package declares `dsh.bundle` (its `cordis.patch.yml` inserts the `tool-godot-bridge` row) — appends it to the profile's `dsh.profile.bundles` layer list. The `web` profile is the standard one the Web app already boots from, so this simply adds the tools to standard mode — **no new profile is created**. After a restart, the seventeen `godot_*` tools are available in every session on that profile. Listed in the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) community registry (topic: `dsh-plugin`).

The same command installs a local checkout or tarball (`dsh plugin --profile web add ./path/to/godot-bridge`).

> The plugin is a standard DSH bundle module: it imports `defineTool` from `@deepseek-ai/dsh-tools` and registers via `ctx.tools.register`. It must be installed through the bundle mechanism above. DSH supplies `@deepseek-ai/*` from its own installation through the launcher's runtime resolution: a package installed into the profile resolves them automatically, while a `link:`/symlinked checkout does so only for the names it declares in its own `peerDependencies` (godot-bridge ≥ 0.1.8 declares them — see [DSH 0.2+ compatibility](#dsh-02-compatibility-and-troubleshooting)). Do not copy the file into a user agent preset (`~/.dsh/.agent-presets/...`); that location is outside every resolution scope and cannot resolve `@deepseek-ai/dsh-tools`.

### Uninstall

```sh
dsh plugin --profile web remove godot-bridge
```

Removes the package and its `godot-bridge` bundle layer from the profile — after a restart the seventeen `godot_*` tools are gone from sessions on that profile. The standard `web` profile itself is untouched (this never creates or removes a profile). Stop any running game first with `godot_stop_project`; the plugin's unload cleanup also terminates a Godot child it started. Reinstall any time with the `add` command above.

## DSH 0.2+ compatibility and troubleshooting

DSH 0.2 replaced the old physical module-fallback layer with an in-process **runtime resolution** that the launcher installs into Node's ESM and CommonJS resolvers. The resolver decides, per importing module, whether a bare `@deepseek-ai/*` specifier is routed to the installation's own copy — which is what a plugin importing harness packages depends on:

- **Installed inside the profile** (`dsh plugin add github:…`, a tarball, or any copy under `$DSH_HOME/profiles/<name>/node_modules`): harness packages resolve from the installation automatically. Nothing to declare.
- **Installed as a `link:` dependency** (a symlinked local checkout): the plugin's real path lives outside the profiles tree, and Node's ESM loader resolves symlinks before importing. Such a *linked root* gets harness packages routed **only for names the plugin declares in its own `peerDependencies`** — the resolver reads `peerDependencies` keys, not `dependencies`. godot-bridge ≥ 0.1.8 declares `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`, both marked optional so pnpm never tries to install harness packages from the registry.

### Symptoms

| Symptom | What it means | What to do |
| --- | --- | --- |
| All seventeen `godot_*` tools are missing and the launcher log shows `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools' imported from …/godot-bridge.mjs` | Harness packages were not routed to the installation copy. For a `link:` install this is a missing `peerDependencies` entry (the 0.1.7-and-earlier failure mode) | Update to godot-bridge ≥ 0.1.8, or install without a symlink (`dsh plugin … add ./godot-bridge-<version>.tgz`) |
| The launcher prints `dsh: skipping profile bundle "godot-bridge": …` and the plugin page lists an error | The declared DSH peer range does not match the running runtime version. A **missing** peer imposes no constraint, so it never produces this message | Update the plugin, or accept the risk explicitly: `dsh plugin --profile <profile> allow-version godot-bridge@<version> --dsh-version <runtime> --accept-risk` |
| `godotPath` is absent from the plugin settings page and `godot_set_engine_path` says the settings service is unavailable | A pre-0.1.8 build on DSH 0.2.x, where the legacy `settings.register` API no longer exists | Update to godot-bridge ≥ 0.1.8 |
| The **godot-bridge card** shows no `Godot engine path` field | The browser half that registers this bundle's configuration section (keyed slot `plugins.bundle.config`, keyed by the package name) is not loaded: this bundle's only row is switched off, the host was not restarted after the update, or the installed copy predates the browser half (≤ 0.1.8). On DSH 0.1.6–0.1.x the runtime has no settings-form service, so the field is absent there by design | Update to godot-bridge ≥ 0.2.0 and restart DSH — the update replaces the installed files, and the `dsh.client` scan is cached per Loader row until a restart. If the row is switched off, switch it on. Otherwise set the path with `godot_set_engine_path`, or add a `config:` block to the row (see [install](install.md#gui-field-on-dsh-02)) |
| After upgrading from 0.1.x the tools run a **different Godot build** than the one configured | The pre-0.2 `settings.yaml` section is not migrated (DSH imports it by plugin entry id, and this row's id is `tool-godot-bridge`), so resolution fell back to `godot` on PATH — typically a version-manager shim | Nothing to do on godot-bridge ≥ 0.1.8: on first start the recorded value is written back automatically (only when the field is empty and the file still exists). If a warning names a dropped value instead, the restore did not take effect (the recorded path is gone, or the write was rejected) — set it again with `godot_set_engine_path` |

### Verifying

```sh
npm run check                                                              # static contract check — no DSH needed
node scripts/diagnose-dsh-resolution.mjs --profile <profile> --expect ok   # uses the installed DSH app
```

`npm run check` fails when a bare `@deepseek-ai/*` import is not declared in the manifest, when the bundle patch is missing or does not reference the package, when the entry point loses its named exports, or when the browser half breaks its own contract (a `dsh.client` member the host does not read, a platform other than `web`, an `exports["./client"]` target that is missing or unshipped, a `__ModuleLoader__` id that is not the package name, a `require()` outside the platform seed modules, a `plugins.bundle.config` key that is not this bundle's package name, or a `plugins.row.config` key that names no row the patch declares). The diagnostic prints the profile's bundle layers, skipped bundles, detected linked roots, and the resolution result for each harness import the plugin makes — run it before and after a fix, or when DSH changes its resolution rules again.

Then restart DSH (or reload the profile from the Plugins page) and confirm that a new session lists the seventeen `godot_*` tools.

## Update notices

On load the plugin does a **best-effort** version check: it fetches the repo's `main`-branch `package.json` (`raw.githubusercontent.com`, 5s timeout, silent on failure/offline) and compares it with the installed version. When a newer version exists it registers a system-prompt section, so the model surfaces **"godot-bridge update available: installed X, latest Y"** in every session until the plugin is updated (`dsh plugin --profile web update godot-bridge`, then restart DSH). `godot_ping` additionally reports `plugin_version` / `latest_version` / `update_available` for on-demand checks.

**To publish an update**: bump `version` in `package.json` (the release marker) and push — an unchanged version triggers no notice. Forks: set `repository` in `package.json` and the check follows the fork automatically.

Known limitations: the notice is a system-prompt section, so presets whose persona is complete/suppressing (e.g. 极简模式 / `minimal`) do not show it; the check needs network access at boot.

## Usage

```text
godot_run_project            # start the game (default: current workspace)
godot_ping                   # confirm 9090 answers
godot_command get_scene_tree # inspect the scene graph
godot_command get_ui_elements
godot_command eval {code: "return get_tree().current_scene.name"}
godot_command click {x: 576, y: 300}
godot_screenshot             # view the game
godot_get_debug_output       # read the boot log
godot_stop_project           # done
```

Godot executable resolution: per-tool `godot_path` argument → the `godotPath` plugin setting (the `tool-godot-bridge` row's config: the `Godot engine path` field on the godot-bridge card's page on DSH 0.2.x, the `godot_set_engine_path` tool, or the plugin settings section on 0.1.x) → the `godot` command on PATH. Nothing to configure when `godot` is on PATH; otherwise set the engine path and point at the **real exe**, never a shim.

## Pitfalls (learned the hard way)

- **DSH file sandbox vs Godot `user://`**: launching Godot through the sandboxed shell executor (pwsh/bash tool) propagates a restricted token and Godot crashes at startup (`Failed to open 'user://logs/…'`, signal 11). godot-bridge spawns via the raw `subprocess` service, which is not file-confined — this is why it works.
- **`node -e` argv**: with `node -e <script> <cmd> <json>`, extra args land at `process.argv[1]`/`[2]` (not `[2]`/`[3]`).
- **eval in debug mode**: a compile error in `eval` code pauses the game at the debugger (same as godot-mcp). Use dynamic access (`p.get("global_position")`) to dodge static typing, and `godot_stop_project` + `godot_run_project` to recover.
- **Real exe, not a version-manager shim**: a shim exits immediately and orphans the real Godot; process management misjudges it as dead.

## Project layout

```
plugin/godot-bridge.mjs           # the plugin (standard DSH module, named exports name/inject/apply)
client/client.js                  # browser half: the row's config page on the Plugins page (dsh.client)
plugin/mcp_interaction_server.gd  # vendored from godot-mcp (MIT) — in-game TCP server autoload
plugin/godot_operations.gd        # vendored from godot-mcp (MIT) — headless ops script
plugin/validate_script.gd         # vendored from godot-mcp (MIT) — GDScript compile-check
package.json                      # dsh.bundle + dsh.client manifest (for `dsh plugin add`)
cordis.patch.yml                  # bundle patch layer (inserts the tool row)
install.md / install.zh-CN.md     # detailed install & maintenance
ARCHITECTURE.md / ARCHITECTURE.zh-CN.md  # how it replaces godot-mcp + protocol details
COVERAGE.md / COVERAGE.zh-CN.md   # full tool-by-tool comparison vs godot-mcp
CHANGELOG.md / CHANGELOG.zh-CN.md  # release history
scripts/check-plugin-contract.mjs  # static dependency-contract check (`npm run check`)
scripts/diagnose-dsh-resolution.mjs  # re-runnable DSH runtime-resolution diagnostic (dev only)
```

`mcp_interaction_server.gd`, `godot_operations.gd` and `validate_script.gd` are vendored from [godot-mcp](https://github.com/tugcantopaloglu/godot-mcp) (MIT). The plugin locates the headless scripts relative to the module (`import.meta.url`); pass an explicit `ops_script` / `validate_script` argument to override.

## License

MIT
