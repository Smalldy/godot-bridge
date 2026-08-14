**English** | [中文](README.zh-CN.md)

# godot-bridge

Native **DeepSeek Harness (DSH)** plugin that launches and drives a running **Godot 4.x** game through its in-game TCP interaction server 鈥?replacing the [`godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) MCP server with first-class agent tools.

No MCP protocol, no Python server, no editor addon. The game side is untouched: `McpInteractionServer` (the `mcp_interaction_server.gd` autoload) already listens on `127.0.0.1:9090` and speaks newline-delimited JSON 鈥?godot-bridge speaks the same protocol natively from inside the DSH host.

## Tools

| Tool | Replaces (godot-mcp) | Purpose |
| --- | --- | --- |
| `godot_run_project` | `run_project` | Launch the project in debug mode (`godot -d --path 鈥), wait for port 9090 |
| `godot_stop_project` | `stop_project` | Terminate the game process (tree-scoped kill) |
| `godot_get_debug_output` | `get_debug_output` | Incremental stdout/stderr of the launched process |
| `godot_command` | all `game_*` (~130) | Send any interaction-server command: `get_scene_tree`, `get_ui_elements`, `eval`, `get/set_property`, `call_method`, `click`, `key_press`, `screenshot`, `raycast`, `serialize_state`, `ui_*`, 鈥?|
| `godot_screenshot` | `game_screenshot` | Viewport capture as base64 PNG |
| `godot_ping` | 鈥?| Probe whether the game answers on 9090 |
| `godot_headless_op` | `read_scene`, `modify_scene_node`, `remove_scene_node`, `attach_script`, `create_resource`, `save_scene`, `create_scene`, `add_node`, `get_uid`, `manage_scene_signals`, 鈥?| Headless static operations (`godot --headless --script godot_operations.gd`): 16 ops, no running game needed |
| `godot_validate_script` | `validate_script` | Headless GDScript compile-check via `validate_script.gd` 鈫?`{valid, errors}` |

The remaining godot-mcp tools (`read_project_settings`, `manage_autoloads`, `manage_input_map`, `create_project`, `export_project`, 鈥? were implemented in the MCP server's own Node process as file/editor operations 鈥?DSH's native file tools (`read`/`write`/`edit`/`glob`/`grep` + shell) already cover those, so they are not duplicated here.

## How it works

```
DSH session
  鈹斺攢 godot-bridge (Host plugin)
       鈹溾攢 godot_run_project 鈹€鈹€鈹€鈹€鈹€鈹€鈻?subprocess.spawn(Godot -d --path <project>)
       鈹溾攢 godot_get_debug_output 鈹€鈻?collect-mode output (incremental offsets)
       鈹斺攢 godot_command / godot_screenshot / godot_ping
            鈹斺攢 subprocess.spawn(node -e <bridge> <command> <paramsJson>)
                 鈹斺攢 TCP 127.0.0.1:9090 鈼勨攢鈹€ in-game McpInteractionServer autoload
```

- The in-game protocol (`{command, params, id}` + newline) is **identical** to godot-mcp, so the game side and any existing workflows keep working.
- Each command spawns a one-shot `node -e` bridge that connects, sends one line, prints the first response line, and exits. The game server is single-connection/single-command (`_busy`), so short-lived connections are a perfect fit.
- Spawning uses the harness's raw `subprocess` service (not the sandboxed shell executor), so Godot can write its `user://` files without the DSH file sandbox killing it (see Pitfalls).

## Requirements

- DeepSeek Harness (a session with a host runtime)
- A Godot 4.x project that registers the `McpInteractionServer` autoload (`mcp_interaction_server.gd` at project root 鈥?godot-mcp projects already have this)
- `node` on PATH
- Godot executable (use the **real exe path**, not the gdvm shim 鈥?see Pitfalls)

## Install

### A. Deployment-level agent preset (recommended, survives restarts)

1. Copy `plugin/godot-bridge.mjs` into your user preset:

   ```
   ${DSH_HOME:-~/.dsh}/.agent-presets/<your-preset>/plugins/godot-bridge.mjs
   ```

2. Add one row to that preset's `agent.cordis.yml` (a plain consumer row 鈥?it registers tools, publishes no service, so no `isolate` realm needed):

   ```yaml
   - id: tool-godot-bridge
     name: './plugins/godot-bridge.mjs'
   ```

3. Validate the mount (`agentPresets.standingKeyFor('<your-preset>')`), then start a session on that preset 鈥?the six `godot_*` tools are available.

> The module is deliberately **zero-import**: user presets live under `~/.dsh`, where Node cannot resolve the harness's `node_modules`. It builds tool definitions with hand-written JSON Schema and registers them via `ctx.tools.register` (which validates `output.render` / `output.schema` / `timeoutMs`, no `defineTool` import needed).

### B. In-session dynamic plugin (quick test)

Tell your agent to define a dynamic Host plugin from `plugin/godot-bridge.js` (`cordis_define`, idPrefix `gbrg`, `code.host` = file content) and run it. This form uses the dynamic-sandbox `harness.defineTool` / `harness.registerTool` API; logic is identical to A.

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

GODOT_PATH resolution: tool arg `godot_path` 鈫?`<workspace>/.omp/mcp.json` `env.GODOT_PATH` 鈫?built-in gdvm 4.7.1 fallback.

## Pitfalls (learned the hard way)

- **DSH file sandbox vs Godot `user://`**: launching Godot through the sandboxed shell executor (pwsh/bash tool) propagates a restricted token and Godot crashes at startup (`Failed to open 'user://logs/鈥?`, signal 11). godot-bridge spawns via the raw `subprocess` service, which is not file-confined 鈥?this is why it works.
- **`node -e` argv**: with `node -e <script> <cmd> <json>`, extra args land at `process.argv[1]`/`[2]` (not `[2]`/`[3]`).
- **eval in debug mode**: a compile error in `eval` code pauses the game at the debugger (same as godot-mcp). Use dynamic access (`p.get("global_position")`) to dodge static typing, and `godot_stop_project` + `godot_run_project` to recover.
- **Real exe, not the gdvm shim**: the gdvm shim exits immediately and orphans the real Godot; process management misjudges it as dead.

## Project layout

```
plugin/godot-bridge.js          # dynamic-plugin form (code.host body)
plugin/godot-bridge.mjs         # deployment form (zero-import ESM module, named exports)
plugin/godot_operations.gd      # vendored from godot-mcp (MIT) 鈥?headless ops script
plugin/validate_script.gd       # vendored from godot-mcp (MIT) 鈥?GDScript compile-check
install.md                      # detailed install & maintenance
ARCHITECTURE.md                 # how it replaces godot-mcp + protocol details
COVERAGE.md                     # full tool-by-tool comparison vs godot-mcp
```

`godot_operations.gd` and `validate_script.gd` are vendored from [godot-mcp](https://github.com/tugcantopaloglu/godot-mcp) (MIT). The deployment form locates them relative to the module (`import.meta.url`); the dynamic form falls back to `<workspace>/tools/godot-bridge/` or the `godot-mcp` checkout, or an explicit `ops_script`/`validate_script` argument.

## License

MIT
