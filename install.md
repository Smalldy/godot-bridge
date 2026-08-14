[English](install.md) | [中文](install.zh-CN.md)

# godot-bridge — install & maintenance

## Files

```
plugin/godot-bridge.mjs           # the plugin (standard DSH module: named exports name/inject/apply)
plugin/mcp_interaction_server.gd  # vendored from godot-mcp (MIT) — in-game TCP server autoload
plugin/godot_operations.gd        # vendored from godot-mcp (MIT) — headless ops script
plugin/validate_script.gd         # vendored from godot-mcp (MIT) — GDScript compile-check
package.json                      # dsh.bundle manifest (for `dsh plugin add`)
cordis.patch.yml                  # bundle patch layer (inserts the tool row)
```

The plugin is a standard DSH bundle module: it imports `defineTool` from `@deepseek-ai/dsh-tools` and registers the fifteen `godot_*` tools via `ctx.tools.register`. It uses named exports (`export const name`, `export const inject`, `export function apply`) — the cordis loader's `unwrapExports` (`exports.default ?? exports`) turns the namespace into the plugin object. Do not add a stray `export default`: it would make `unwrapExports` collapse to that single value and silently drop `name`/`inject`/`apply`.

Because it imports `@deepseek-ai/*`, the module must live where Node can resolve the harness dependency tree — i.e. be installed through the official bundle mechanism (`dsh plugin add`), which puts the package in the profile's `node_modules` (the harness heals the shared `@deepseek-ai/*` layer there at boot). Do **not** copy the file into a user agent preset (`~/.dsh/.agent-presets/...`): Node cannot resolve `@deepseek-ai/dsh-tools` from that location.

## Install

### Recommended: community bundle (`dsh plugin add`)

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` is a pnpm forwarder: it installs the package into the profile and — because the package's `dsh.bundle` manifest points at `cordis.patch.yml`, which inserts the `tool-godot-bridge` row (referenced by package name) — appends `godot-bridge` to the profile's `dsh.profile.bundles` layer list. Pure ESM + assets, no build script, so a git install needs no `allowBuilds` exemption. After a restart, every session on that profile has the fifteen tools.

The same command installs a local checkout or a tarball:

```sh
dsh plugin --profile web add ./path/to/godot-bridge     # local checkout
dsh plugin --profile web add ./godot-bridge-0.1.0.tgz   # pnpm pack output
```

## Config

- GODOT_PATH: tool arg `godot_path` > `<workspace>/.omp/mcp.json` `env.GODOT_PATH` > built-in gdvm 4.7.1 fallback. Always point at the **real exe**, never the gdvm shim.
- Port/host: hardcoded `127.0.0.1:9090` (matches the `McpInteractionServer` autoload default).
- Headless scripts: the plugin locates them relative to the module (`import.meta.url`); pass an explicit `ops_script` / `validate_script` argument to override.

## Maintenance

- Editing `plugin/godot-bridge.mjs` needs no rebuild (plain ESM).
- After changing the plugin, reinstall it into the profile (`dsh plugin --profile web add github:Smalldy/godot-bridge` again) and restart the session.
- The game side (`mcp_interaction_server.gd` autoload) is never modified by the plugin.
