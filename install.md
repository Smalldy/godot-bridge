[English](install.md) | [中文](install.zh-CN.md)

# godot-bridge — install & maintenance

## Files

```
plugin/godot-bridge.js            # dynamic-plugin form: the code.host body for cordis_define
plugin/godot-bridge.mjs           # deployment/bundle form: zero-import ESM module (named exports name/inject/apply)
plugin/mcp_interaction_server.gd  # vendored from godot-mcp (MIT) — in-game TCP server autoload
plugin/godot_operations.gd        # vendored from godot-mcp (MIT) — headless ops script
plugin/validate_script.gd         # vendored from godot-mcp (MIT) — GDScript compile-check
package.json                      # dsh.bundle manifest (for `dsh plugin add`)
cordis.patch.yml                  # bundle patch layer (inserts the tool row)
```

All three forms implement identical logic (TCP bridge + process management + 8 tools); they differ only in the registration API, which each runtime requires:

| | dynamic plugin (B) | deployment preset (A) | community bundle (C) |
| --- | --- | --- | --- |
| runtime | dynamic sandbox (vm) | real cordis plugin (agent preset) | real cordis plugin (profile layer) |
| row name | `./plugins/godot-bridge.mjs` (relative) | `./plugins/godot-bridge.mjs` (relative) | `godot-bridge` (package name) |
| registration | `harness.defineTool` + `harness.registerTool` | `ctx.tools.register` | `ctx.tools.register` |
| parameters | DSL / raw-JSON-schema wrapper, root must stay open | raw JSON Schema, root `additionalProperties:false` ok | raw JSON Schema, root `additionalProperties:false` ok |
| imports | none (builtins only) | none (zero-import, see below) | none (zero-import) |

## Why the deployment/bundle form is zero-import

User presets live under `${DSH_HOME:-~/.dsh}/.agent-presets/`. Node's upward `node_modules` walk from there never reaches the harness's dependencies, so a local plugin module cannot `import` any `@deepseek-ai/*` package. The module therefore builds tool definitions with hand-written JSON Schema and registers them through the injected `tools` service — `ctx.tools.register` only validates `output.render`, `output.schema` (via `assertSupportedJsonSchema`) and `timeoutMs`; it does not require a `defineTool`-produced definition.

The module uses named exports (`export const name`, `export const inject`, `export function apply`) — the cordis loader's `unwrapExports` (`exports.default ?? exports`) turns the namespace into the plugin object. Do not add a stray `export default`.

## Install

### A. Deployment-level agent preset (recommended for a single machine)

1. Copy `plugin/godot-bridge.mjs` → `<preset-dir>/plugins/godot-bridge.mjs`
2. Append to `<preset-dir>/agent.cordis.yml`:

   ```yaml
   - id: tool-godot-bridge
     name: './plugins/godot-bridge.mjs'
   ```

3. Validate: `agentPresets.standingKeyFor('<preset-id>')` — must return without error
4. Start a session on that preset; confirm the eight `godot_*` tools in the tool list

### B. In-session dynamic plugin (quick test)

Tell your agent: *read `plugin/godot-bridge.js`, define a dynamic plugin (`cordis_define`, kind new, idPrefix `gbrg`, code.host = file content), then `cordis_run`.* Dynamic plugins live in the session registry and are lost on process restart — use A or C for anything durable.

### C. Community bundle (`dsh plugin add`)

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

The package's `dsh.bundle` manifest points at `cordis.patch.yml`, which inserts the `tool-godot-bridge` row (referenced by package name) into the profile. Pure ESM + assets — no build script, so a git install needs no `allowBuilds` exemption. After a restart, every session on that profile has the eight tools.

## Config

- GODOT_PATH: tool arg `godot_path` > `<workspace>/.omp/mcp.json` `env.GODOT_PATH` > built-in gdvm 4.7.1 fallback. Always point at the **real exe**, never the gdvm shim.
- Port/host: hardcoded `127.0.0.1:9090` (matches the `McpInteractionServer` autoload default).
- Headless scripts: the deployment/bundle form locates them relative to the module (`import.meta.url`); the dynamic form falls back to `<workspace>/tools/godot-bridge/` or the `godot-mcp` checkout, or an explicit `ops_script` / `validate_script` argument.

## Maintenance

- Editing `plugin/godot-bridge.mjs` needs no rebuild (plain ESM).
- After changing a preset composition, re-run `standingKeyFor` to mount-validate.
- The game side (`mcp_interaction_server.gd` autoload) is never modified by the plugin.
