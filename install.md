# godot-bridge — install & maintenance

## Files

```
plugin/godot-bridge.js    # dynamic-plugin form: the code.host body for cordis_define
plugin/godot-bridge.mjs   # deployment form: zero-import ESM module (named exports name/inject/apply)
```

Both implement identical logic (TCP bridge + process management + 6 tools). The only difference is the registration API, forced by the two runtimes:

| | dynamic plugin (A) | deployment preset (B) |
| --- | --- | --- |
| runtime | dynamic sandbox (vm) | real cordis plugin |
| registration | `harness.defineTool` + `harness.registerTool` | `ctx.tools.register` |
| parameters | DSL / raw-JSON-schema wrapper, root must stay open | raw JSON Schema, root `additionalProperties:false` ok |
| imports | none (builtins only) | none (module must be zero-import — see below) |

## Why the deployment form is zero-import

User presets live under `${DSH_HOME:-~/.dsh}/.agent-presets/`. Node's upward `node_modules` walk from there never reaches the harness's dependencies, so a local plugin module cannot `import` any `@deepseek-ai/*` package. The module therefore builds tool definitions with hand-written JSON Schema and registers them through the injected `tools` service — `ctx.tools.register` only validates `output.render`, `output.schema` (via `assertSupportedJsonSchema`) and `timeoutMs`; it does not require a `defineTool`-produced definition.

The composition row references the module by a **relative path** (resolved against the composition directory), so the file travels with the preset:

```yaml
- id: tool-godot-bridge
  name: './plugins/godot-bridge.mjs'
```

The row only registers tools and publishes no service → no `isolate` realm needed; keep it as a plain top-level row (like `tool-bash`).

The module uses named exports (`export const name`, `export const inject`, `export function apply`) — the cordis loader's `unwrapExports` (`exports.default ?? exports`) turns the namespace into the plugin object. Do not add a stray `export default`.

## Install (deployment preset)

1. Copy `plugin/godot-bridge.mjs` → `<preset-dir>/plugins/godot-bridge.mjs`
2. Append the row above to `<preset-dir>/agent.cordis.yml`
3. Validate: `agentPresets.standingKeyFor('<preset-id>')` — must return without error
4. Start a session on that preset; confirm the six `godot_*` tools in the tool list

## Install (dynamic, in-session)

Tell the agent: *read `plugin/godot-bridge.js`, define a dynamic plugin (`cordis_define`, kind new, idPrefix `gbrg`, code.host = file content), then `cordis_run`.* Dynamic plugins live in the session registry and are lost on process restart — use the preset form for anything durable.

## Config

- GODOT_PATH: tool arg `godot_path` > `<workspace>/.omp/mcp.json` `env.GODOT_PATH` > built-in gdvm 4.7.1 fallback. Always point at the **real exe**, never the gdvm shim.
- Port/host: hardcoded `127.0.0.1:9090` (matches `McpInteractionServer` autoload default).

## Maintenance

- Editing `plugin/godot-bridge.mjs` needs no rebuild (plain ESM).
- After changing a preset composition, re-run `standingKeyFor` to mount-validate.
- The game side (`mcp_interaction_server.gd` autoload) is never modified by the plugin.
