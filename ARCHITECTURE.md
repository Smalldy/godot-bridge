[English](ARCHITECTURE.md) | [中文](ARCHITECTURE.zh-CN.md)

# godot-bridge — architecture

## Why this exists

[godot-mcp](https://github.com/tugcantopaloglu/godot-mcp) is an MCP server (stdio JSON-RPC) wrapping three layers of real work:

1. **Process management** — `spawn(godot -d --path <project>)`, collect output, kill on demand.
2. **Runtime game control** — connect to the game's `McpInteractionServer` autoload on **TCP 127.0.0.1:9090** with newline-delimited JSON `{command, params, id}`; ~130 `game_*` tools map onto these commands.
3. **Headless static operations** — `godot --headless --path <project> --script godot_operations.gd <op> <json>` (scene edits, script validation, project creation).

The MCP layer itself contributes nothing but an outer JSON-RPC shell. DeepSeek Harness already has native equivalents for everything:

| layer | godot-mcp | godot-bridge |
| --- | --- | --- |
| process | Node `spawn` | host `subprocess.spawn` (same args) |
| runtime | TCP 9090 JSON | same TCP 9090 JSON via a one-shot `node -e` bridge |
| headless | `godot --headless …` | included: `godot_headless_op` + `godot_validate_script` over vendored `godot_operations.gd` / `validate_script.gd` |

Crucially, **the game side does not know MCP exists**: `mcp_interaction_server.gd` is a plain TCP JSON server. Replacing the MCP server requires zero game-side changes; `project.godot` autoloads stay as-is.

## The TCP bridge

The dynamic sandbox and the preset environment expose no raw `net` socket to plugin code, so each command spawns a short-lived `node -e` bridge:

```
node -e "<bridge>" <command> <paramsJson>
```

The bridge connects to 127.0.0.1:9090, writes one `{command, params, id:1}\n`, prints the first complete response line, and exits. The game server is single-connection with a `_busy` flag, so this connection-per-command model is a perfect match. `argv[1]`/`argv[2]` carry the command and params (`node -e` puts extra args at index 1+).

## Sandbox interaction (the important one)

DSH's file sandbox (`workspace-write`) restricts writes to the workspace + temp areas. The **shell executor** (pwsh/bash tools) applies that policy to the whole process tree (Windows restricted-token runner), so launching Godot from a shell tool crashes it: Godot writes `user://` (= `%APPDATA%\Godot\app_userdata\<project>\`, startup logs) and dies with `Failed to open 'user://logs/…'` → signal 11.

godot-bridge spawns through the harness's **raw `subprocess` service** — the unconfined primitive the shell executor itself uses internally — so Godot runs normally. Do not launch the game through pwsh/bash tools in a sandboxed session; use `godot_run_project`.

## Tool model

All tools return the game's response JSON verbatim (canonical value validated against `{type:'object', additionalProperties:true}`), rendered as text. Tool calls are exclusive by default (no `isConcurrencySafe`), matching the single-command game server.

## Architecture diagrams

### System overview

```mermaid
flowchart TB
    subgraph GITHUB["GitHub — Smalldy/godot-bridge"]
        REPO["bundle<br/>package.json (dsh.bundle) · cordis.patch.yml · plugin/"]
    end

    subgraph DSH["DeepSeek Harness host (web profile)"]
        PROFILE["$DSH_HOME/profiles/web/package.json<br/>dsh.profile.bundles = base · web-app · godot-bridge"]
        NODE["profiles/web/node_modules/godot-bridge"]
        PLUGIN["cordis row tool-godot-bridge<br/>godot-bridge.mjs apply(ctx)"]
        TOOLS["16 godot_* tools<br/>defineTool + ctx.tools.register"]
        PROMPT["system-prompt sections<br/>update notice (conditional)"]
    end

    subgraph CHANNELS["Plugin channels"]
        BRIDGE["node -e one-shot TCP bridge"]
        HEADLESS["godot --headless --script<br/>godot_operations.gd / validate_script.gd"]
        PROC["subprocess.spawn(godot -d --path …)"]
        FILE["fs service<br/>project.godot · export_presets.cfg"]
        NET["fetch raw.githubusercontent.com<br/>boot-time version check"]
    end

    subgraph GAME["Godot project (user)"]
        AUTOLOAD["project.godot [autoload]<br/>McpInteractionServer"]
        SERVER["mcp_interaction_server.gd<br/>TCP 127.0.0.1:9090"]
        SFILES["scenes/*.tscn · resources/*.tres<br/>scripts/*.gd"]
    end

    GITHUB -->|"dsh plugin add github:… / release .tgz"| PROFILE
    PROFILE --> NODE
    NODE --> PLUGIN
    PLUGIN --> TOOLS
    PLUGIN --> PROMPT
    TOOLS --> BRIDGE
    BRIDGE -->|"{command, params, id}<br/>newline-delimited JSON"| SERVER
    TOOLS --> HEADLESS
    HEADLESS --> SFILES
    TOOLS --> PROC
    PROC -->|"boots the game"| SERVER
    TOOLS --> FILE
    FILE --> SFILES
    PLUGIN --> NET
    AUTOLOAD --> SERVER
```

### Tool channels

```mermaid
flowchart LR
    subgraph TOOLS["godot_* tools"]
        P["process<br/>run / stop / get_debug_output / ping"]
        R["runtime<br/>command / screenshot"]
        H["headless<br/>headless_op / validate_script / export_project"]
        E["project-edit<br/>set_project_setting / manage_* / create_*"]
    end
    P -->|"spawn + collected output"| G["Godot process"]
    R -->|"TCP 9090 via node -e bridge"| S["McpInteractionServer<br/>inside the game"]
    H -->|"godot --headless"| F["scene / resource / script files"]
    E -->|"fs service"| F
    S --> G
```

### godot_run_project — launch flow

```mermaid
sequenceDiagram
    participant Agent
    participant RP as godot_run_project
    participant H as plugin helpers
    participant FS as fs service
    participant GO as Godot process
    participant SRV as McpInteractionServer 9090

    Agent->>RP: execute({project_path, scene, wait_ms})
    RP->>H: ensureInteractionAutoload(project)
    H->>FS: read project.godot
    alt autoload missing
        H->>FS: copy vendored gd → autoload/<br/>register [autoload] entry
    end
    RP->>H: launchProject(project, …)
    H->>GO: subprocess.spawn(godot -d --path project)
    Note over GO: boots — autoload starts the TCP server
    loop poll ≤ wait_ms (default 20s, every ~4s)
        H->>SRV: get_performance via node -e bridge
        SRV-->>H: ok
    end
    RP-->>Agent: {game_ready, autoload, pid, port, note}
```

### Runtime tool pre-flight (self-healing guard)

```mermaid
sequenceDiagram
    participant Agent
    participant T as godot_command / godot_screenshot
    participant G as ensureGameService
    participant LP as launchProject
    participant SRV as McpInteractionServer 9090

    Agent->>T: execute(...)
    T->>G: probe get_performance (1.5s timeout)
    alt server answers
        G-->>T: pass
    else no game + project derivable<br/>(project_path or workspace project.godot)
        G->>LP: auto-start project<br/>(autoload self-heal + spawn + wait ready)
        LP-->>G: game_ready
        G-->>T: pass
    else nothing derivable
        G-->>T: guidance error (call godot_run_project)
    end
    T->>SRV: runGameCommand(command) via bridge
    SRV-->>T: response JSON
    T-->>Agent: result
```

## Known behavior notes

- `eval` compile errors pause a debug-mode game at the debugger (identical to godot-mcp). Recover with `godot_stop_project` + `godot_run_project`; write dynamic-access code (`node.get("prop")`) to dodge static typing.
- `godot_get_debug_output` is incremental (offset-based readers).
- The configured Godot path must be the real exe; a version-manager shim exits immediately and orphans the real process.
