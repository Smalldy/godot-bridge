**English** | [中文](README.zh-CN.md)

# godot-bridge

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![Listed on DSH Directory](https://dsh.directory/badges/listed.svg)](https://dsh.directory/plugins/smalldy/godot-bridge)

Native **DeepSeek Harness (DSH)** plugin that launches and drives a running **Godot 4.x** game through its in-game TCP interaction server — replacing the [`godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) MCP server with first-class agent tools.

No MCP protocol, no Python server, no editor addon. The game side is untouched: `McpInteractionServer` (the `mcp_interaction_server.gd` autoload) already listens on `127.0.0.1:9090` and speaks newline-delimited JSON — godot-bridge speaks the same protocol natively from inside the DSH host.

## Tools

| Tool | Replaces (godot-mcp) | Purpose |
| --- | --- | --- |
| `godot_run_project` | `run_project` | Launch the project in debug mode (`godot -d --path …`), wait for port 9090 |
| `godot_stop_project` | `stop_project` | Terminate the game process (tree-scoped kill) |
| `godot_get_debug_output` | `get_debug_output` | Incremental stdout/stderr of the launched process |
| `godot_command` | all `game_*` (~105) | Send any interaction-server command: `get_scene_tree`, `get_ui_elements`, `eval`, `get/set_property`, `call_method`, `click`, `key_press`, `screenshot`, `raycast`, `serialize_state`, `ui_*`, … |
| `godot_screenshot` | `game_screenshot` | Viewport capture as base64 PNG |
| `godot_ping` | — | Probe whether the game answers on 9090 (also reports installed/latest plugin version) |
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

## Task Center

The same package mounts a second component row, `godot-bridge/task-center`: a project task board, a dependency-driven dispatcher, file locks, and a centre-column GUI panel (sidebar entry “Tasks”).

### Execution flow

Every task runs in its own git worktree — `<project>/.worktrees/<taskId>-<attempt>` on branch `task/<taskId>-<attempt>`, created when the task is claimed. A task is never dispatched into the shared checkout; if the project cannot host a worktree, dispatch refuses to start instead.

1. **Work**: the assignee edits only that checkout and runs the tests there.
2. **Submit**: `submit` commits the worktree and opens a merge request (base = the current target head, head = the new commit, changed files = the base..head diff).
3. **Testing**: with `testing = self` (the default) the assignee's own verification is the record; with `testing = independent` the host checks the branch out in a temporary `verify-<taskId>` worktree, runs `npm run verify` there, and writes the `verdict` itself — a request cannot be merged until that verdict passes. No agent decides pass/fail.
4. **Merge**: a host sweep every 5 seconds enqueues ready requests into the serial merge queue, which integrates the branch in a throwaway worktree, runs the project verification there, and only when it is green fast-forwards the target branch and removes the now-merged task worktree.
5. **Exceptions**: a conflict or a red verification marks the request and notifies the owner; the target branch is never touched. `mergeRequest` / `rejectMerge` / `refreshMerge` stay available to the user or the `merger` teammate for manual integration, audit or repair.

- **Board**: `<project>/.agents/tasks.json`. Schema v2; a v1 board migrates on read. Duplicate ids, malformed entries and future versions are refused instead of overwritten. Add the file to the project's `.gitignore` — it is working state, not source.
- **Action API**: the `task_center` tool and `POST /godot-bridge/task-center/action` share one vocabulary: `create / update / delete / list / get / board / start / pause / approveStart / rejectStart / cancelStartRequest / settings / tick / submit / cancel / reopen / block / unblock / retry / lock / unlock / locks / forceUnlock / openProject`.
- **Dependencies**: `B.dependsOn = [A]` means B runs only after A is done. Ready tasks are ordered by `priority` descending, then creation time. `A <- B <- C`, `D`, `E <- F` dispatch A, D, E first; A's completion dispatches B, E's completion dispatches F.
- **Dispatch**: start/pause is a project-level state persisted in the board. The GUI exposes one number, **maximum concurrency**: at most that many tasks run at once; the WorkAgent cap is derived as concurrency + 1, a worker is spawned when none is idle, and a task blocks after 3 consecutive failures (the advanced `settings` action can still override these). Every dispatch claims the task first (a 60-minute lease that any assignee activity renews, plus a fixed host heartbeat), then hands it to Agent Teams — `sendMessage` to an idle member, otherwise `spawnTeammate`. A lapsed lease is settled by liveness: a live holder keeps the task, and only a gone/failed holder (or one past the four-hour per-attempt cap) is handed over, with the next attempt adopting the previous checkout instead of restarting. A host restart recovers claims from the previous process.
- **File locks**: `writeFiles` declares what a task will write. The scheduler acquires all of them atomically before dispatch and releases them on completion, block, cancel or lease handover. An agent may `lock` extra files for its running task. Paths canonicalise to project-relative POSIX paths; a directory lock conflicts with every child path.
- **GUI**: board (ready / waiting / running / done / blocked), queue, workers and locks views; start/pause, create/edit, submit/retry/reopen, dispatch settings. The workers view shows the lead, cap, busy/idle/provisioning/failed counts and each WorkAgent's current task. The locks view names the holder task/agent and the pending ready tasks that would wait on the file; waiters are advisory contention, not a FIFO queue. A pending start request appears as a banner with approve/reject. It polls the host snapshot every 2.5 s.
- **Consent**: an agent's `start` records `dispatch.request`; it does not start the scheduler. The panel shows the request, and only the user's `approveStart` runs it. `pause` is immediate for either side; `settings` is user-only.
- **Safety**: HTTP writes require `application/json` and a same-origin `Origin`; `?project=` is only a read hint, while switching projects goes through `openProject` (which verifies the directory).

```sh
# create a task from outside the GUI (any HTTP client)
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' \
  -d '{"action":"create","project":"/path/to/game","title":"A","writeFiles":["scripts/a.gd"]}'
# start / pause dispatch
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' -d '{"action":"start","project":"/path/to/game"}'
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' -d '{"action":"pause","project":"/path/to/game"}'
```

`npm test` covers board, service, locks, dispatch, routes, tool, activation and client.

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
