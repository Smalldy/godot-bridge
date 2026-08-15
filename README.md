**English** | [中文](README.zh-CN.md)

# godot-bridge

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Native **DeepSeek Harness (DSH)** plugin that launches and drives a running **Godot 4.x** game through its in-game TCP interaction server — replacing the [`godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) MCP server with first-class agent tools.

No MCP protocol, no Python server, no editor addon. The game side is untouched: `McpInteractionServer` (the `mcp_interaction_server.gd` autoload) already listens on `127.0.0.1:9090` and speaks newline-delimited JSON — godot-bridge speaks the same protocol natively from inside the DSH host.

## Tools

| Tool | Replaces (godot-mcp) | Purpose |
| --- | --- | --- |
| `godot_run_project` | `run_project` | Launch the project in debug mode (`godot -d --path …`), wait for port 9090 |
| `godot_stop_project` | `stop_project` | Terminate the game process (tree-scoped kill) |
| `godot_get_debug_output` | `get_debug_output` | Incremental stdout/stderr of the launched process |
| `godot_command` | all `game_*` (~130) | Send any interaction-server command: `get_scene_tree`, `get_ui_elements`, `eval`, `get/set_property`, `call_method`, `click`, `key_press`, `screenshot`, `raycast`, `serialize_state`, `ui_*`, … |
| `godot_screenshot` | `game_screenshot` | Viewport capture as base64 PNG |
| `godot_ping` | — | Probe whether the game answers on 9090 (also reports installed/latest plugin version) |
| `godot_headless_op` | `read_scene`, `modify_scene_node`, `remove_scene_node`, `attach_script`, `create_resource`, `save_scene`, `create_scene`, `add_node`, `get_uid`, `manage_scene_signals`, … | Headless static operations (`godot --headless --script godot_operations.gd`): 16 ops, no running game needed |
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
- A Godot 4.x project with the `McpInteractionServer` autoload registered. If your project does not have it yet, copy `plugin/mcp_interaction_server.gd` to the project root and register it as an autoload named `McpInteractionServer` (godot-mcp projects already have this). **The plugin also injects a system-prompt guidance that makes the agent check for this autoload and repair it automatically (copy the vendored file + register) before driving a project** — a missing autoload is fixed without manual work.
- `node` on PATH
- Godot executable (use the **real exe path**, not the gdvm shim — see Pitfalls)

## Install

**Recommended — one command** (requires the `dsh` CLI):

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` is a pnpm forwarder: it installs the package into the profile's `node_modules` and — because the package declares `dsh.bundle` (its `cordis.patch.yml` inserts the `tool-godot-bridge` row) — appends it to the profile's `dsh.profile.bundles` layer list. The `web` profile is the standard one the Web app already boots from, so this simply adds the tools to standard mode — **no new profile is created**. After a restart, the fifteen `godot_*` tools are available in every session on that profile. Listed in the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) community registry (topic: `dsh-plugin`).

The same command installs a local checkout or tarball (`dsh plugin --profile web add ./path/to/godot-bridge`).

> The plugin is a standard DSH bundle module: it imports `defineTool` from `@deepseek-ai/dsh-tools` and registers via `ctx.tools.register`. It must be installed through the bundle mechanism above — the harness heals the shared `@deepseek-ai/*` dependency layer inside the profile's `node_modules`, which is what makes the import resolve. Do not copy the file into a user agent preset (`~/.dsh/.agent-presets/...`); Node cannot resolve `@deepseek-ai/dsh-tools` from that location.

### Uninstall

```sh
dsh plugin --profile web remove godot-bridge
```

Removes the package and its `godot-bridge` bundle layer from the profile — after a restart the fifteen `godot_*` tools are gone from sessions on that profile. The standard `web` profile itself is untouched (this never creates or removes a profile). Stop any running game first with `godot_stop_project`; the plugin's unload cleanup also terminates a Godot child it started. Reinstall any time with the `add` command above.

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

GODOT_PATH resolution: tool arg `godot_path` → `<workspace>/.omp/mcp.json` `env.GODOT_PATH` → built-in gdvm 4.7.1 fallback.

## Pitfalls (learned the hard way)

- **DSH file sandbox vs Godot `user://`**: launching Godot through the sandboxed shell executor (pwsh/bash tool) propagates a restricted token and Godot crashes at startup (`Failed to open 'user://logs/…'`, signal 11). godot-bridge spawns via the raw `subprocess` service, which is not file-confined — this is why it works.
- **`node -e` argv**: with `node -e <script> <cmd> <json>`, extra args land at `process.argv[1]`/`[2]` (not `[2]`/`[3]`).
- **eval in debug mode**: a compile error in `eval` code pauses the game at the debugger (same as godot-mcp). Use dynamic access (`p.get("global_position")`) to dodge static typing, and `godot_stop_project` + `godot_run_project` to recover.
- **Real exe, not the gdvm shim**: the gdvm shim exits immediately and orphans the real Godot; process management misjudges it as dead.

## Project layout

```
plugin/godot-bridge.mjs           # the plugin (standard DSH module, named exports name/inject/apply)
plugin/mcp_interaction_server.gd  # vendored from godot-mcp (MIT) — in-game TCP server autoload
plugin/godot_operations.gd        # vendored from godot-mcp (MIT) — headless ops script
plugin/validate_script.gd         # vendored from godot-mcp (MIT) — GDScript compile-check
package.json                      # dsh.bundle manifest (for `dsh plugin add`)
cordis.patch.yml                  # bundle patch layer (inserts the tool row)
install.md / install.zh-CN.md     # detailed install & maintenance
ARCHITECTURE.md / ARCHITECTURE.zh-CN.md  # how it replaces godot-mcp + protocol details
COVERAGE.md / COVERAGE.zh-CN.md   # full tool-by-tool comparison vs godot-mcp
CHANGELOG.md / CHANGELOG.zh-CN.md  # release history
```

`mcp_interaction_server.gd`, `godot_operations.gd` and `validate_script.gd` are vendored from [godot-mcp](https://github.com/tugcantopaloglu/godot-mcp) (MIT). The plugin locates the headless scripts relative to the module (`import.meta.url`); pass an explicit `ops_script` / `validate_script` argument to override.

## License

MIT
