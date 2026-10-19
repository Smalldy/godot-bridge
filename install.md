[English](install.md) | [中文](install.zh-CN.md)

# godot-bridge — install & maintenance

## Files

```
plugin/godot-bridge.mjs           # the plugin's tool row (standard DSH module: named exports name/inject/apply)
plugin/task-center/*.mjs          # the task center's host half (board, schema, service, dispatch, api, git, roles, harness)
client/client.js                  # browser half: the engine-path config page AND the task-center panel (one dsh.client bundle)
plugin/mcp_interaction_server.gd  # vendored from godot-mcp (MIT) — in-game TCP server autoload
plugin/godot_operations.gd        # vendored from godot-mcp (MIT) — headless ops script
plugin/validate_script.gd         # vendored from godot-mcp (MIT) — GDScript compile-check
package.json                      # dsh.bundle + dsh.client manifest (for `dsh plugin add`)
cordis.patch.yml                  # bundle patch layer (inserts BOTH rows: the tool row and the task center)
```

The plugin is a standard DSH bundle module: it imports `defineTool` from `@deepseek-ai/dsh-tools` and registers the seventeen `godot_*` tools via `ctx.tools.register`. It uses named exports (`export const name`, `export const inject`, `export function apply`) — the cordis loader's `unwrapExports` (`exports.default ?? exports`) turns the namespace into the plugin object. Do not add a stray `export default`: it would make `unwrapExports` collapse to that single value and silently drop `name`/`inject`/`apply`.

Since 0.3.0 the bundle inserts **two rows of the same package** (`cordis.patch.yml`): `tool-godot-bridge` (the seventeen `godot_*` tools) and `task-center` (`godot-bridge/task-center`: the `task_center` tool plus the task-center panel). Cards follow bundles and components follow rows, so both rows sit on one Plugins-page card, and one browser bundle (`client/client.js`) carries both surfaces. `task_center` is deliberately not a `godot_*` tool, so "seventeen `godot_*` tools" stays exact.

The task center keeps its **runtime state inside the project** that uses it, never in the package or the profile: `<project>/.agents/tasks.json` (the board), `.agents/roles.json` (role profiles) and `.agents/test-harness.json` (harness configuration). They are working state — add `.agents/` to that project's `.gitignore`. For the board, roles, merge queue and harness flow see [README → Task Center](README.md#task-center) and [README → Isolated DSH test harness](README.md#isolated-dsh-test-harness); this page stays on install and maintenance.

Because it imports `@deepseek-ai/*`, the module must resolve the harness dependency tree at load time. DSH 0.2 does that with the launcher's runtime resolution instead of a physical fallback layer: a bundle installed into `$DSH_HOME/profiles/<name>/node_modules` is routed to the installation's copies automatically, while a `link:` checkout — whose real path lies outside the profiles tree, because Node's ESM loader resolves symlinks before importing — is routed only for names the plugin declares in its own `peerDependencies`. godot-bridge ≥ 0.1.8 declares `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` (both `peerDependenciesMeta.optional`, so pnpm never installs harness packages from the registry). Keep that declaration when you edit the manifest — `npm run check` fails without it. Do **not** copy the file into a user agent preset (`~/.dsh/.agent-presets/...`): that location is outside every resolution scope and cannot resolve `@deepseek-ai/dsh-tools`.

## Install

### Recommended: community bundle (`dsh plugin add`)

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` is a pnpm forwarder: it installs the package into the profile and — because the package's `dsh.bundle` manifest points at `cordis.patch.yml`, which inserts the `tool-godot-bridge` and `task-center` rows (both referenced by package name) — appends `godot-bridge` to the profile's `dsh.profile.bundles` layer list. Pure ESM + assets, no build script, so a git install needs no `allowBuilds` exemption. After a restart, every session on that profile has the seventeen `godot_*` tools plus `task_center`, and the Plugins page shows the task-center panel.

The same command installs a local checkout or a tarball:

```sh
dsh plugin --profile web add ./path/to/godot-bridge     # local checkout
dsh plugin --profile web add ./godot-bridge-0.2.0.tgz   # pnpm pack output
```

### Local development (`link:`)

A `link:` dependency (`"godot-bridge": "link:/path/to/godot-bridge"` — what pnpm writes when you add a local checkout to the profile) turns the profile's `node_modules/godot-bridge` into a symlink to your working copy, so code edits take effect without reinstalling: the browser half (`client/client.js`) is hot-swapped by the host's artifact polling within about a second, and the plugin's host half is re-imported on a profile reload. A `package.json` edit is the exception — see below. It is also the one install shape the launcher's runtime resolution cannot route by itself: the plugin's real path sits outside the profiles tree, and a *linked root* gets harness packages routed only for names the plugin declares in its `peerDependencies`. That declaration is why 0.1.8 exists — without it the whole bundle fails to import (`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools' imported from …godot-bridge.mjs`) and none of the seventeen `godot_*` tools (nor `task_center`) registers.

- Prefer a non-symlinked install when you do not need live edits: `pnpm pack`, then `dsh plugin --profile web add ./godot-bridge-0.2.0.tgz` (reinstall after each change).
- After changing the plugin's host half, reload the profile (Plugins page) or restart DSH, then confirm the seventeen `godot_*` tools and the task-center panel. After changing `package.json` — the `dsh.client` declaration, `exports`, `files` — **restart DSH**: the client-module scan reads a package's manifest once per Loader row and caches it until the host restarts, so a reload is not enough. `npm run check` guards the contract and `scripts/diagnose-dsh-resolution.mjs` reports what the launcher actually routes — see [README → DSH 0.2+ compatibility](README.md#dsh-02-compatibility-and-troubleshooting).

## Uninstall

```sh
dsh plugin --profile web remove godot-bridge
```

`dsh plugin remove` forwards to `pnpm remove` in the profile directory and then reconciles `dsh.profile.bundles` — the dependency **and** the `godot-bridge` bundle layer are both removed from the profile's `package.json`. After a restart, the seventeen `godot_*` tools, the `task_center` tool and the task-center panel are gone from sessions on that profile. The `web` profile itself (the standard one) is untouched; removing a plugin never creates or deletes a profile.

Notes:

- If a Godot process is running, stop it first with `godot_stop_project` — once the plugin is gone there is no tool to do it. As a safety net, the plugin registers an unload effect that terminates any Godot child it started, so a session reload after removal cleans it up.
- Nothing else is touched: `project.godot`, the game's `McpInteractionServer` autoload, and any game files are never modified by install or removal.
- Reinstall any time with the `add` command above.

## Config

- Godot executable: per-tool `godot_path` argument > the `godotPath` plugin setting > the `godot` command on PATH. The plugin author does **not** preset a path (Godot is a portable exe that can live anywhere); set your own engine path when it isn't on PATH. Always point at the **real exe**, never a version-manager shim.

  `godotPath` is a `.volatile()` field of the plugin's own config: it is read live (volatile fields update without remounting the plugin). Where the value lives:

  - **DSH 0.2.x** — the config of the `tool-godot-bridge` row, reachable in three equivalent ways: the `Godot engine path` field on the **godot-bridge card's page** of the Plugins page (see [GUI field](#gui-field-on-dsh-02) below), the `godot_set_engine_path` tool (it writes the profile patch through `ctx.configEditor.edit(...)` and applies immediately — no restart), or a hand-written `config:` block on that row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. The tool checks that the file exists before writing and reports `persisted: 'profile-patch'`; the GUI field is a plain text save (a browser cannot stat files), so point it at the real exe.

    ```yaml
    - id: tool-godot-bridge
      config:
        godotPath: C:/path/to/Godot_v4.4-stable_win64.exe
    ```
  - **DSH 0.1.6–0.1.x** — the legacy settings section (`godot-bridge:` in `$DSH_HOME/settings.yaml`, or that release's plugin-config page); the plugin still uses `settings.register` when that API exists and reports `persisted: 'settings'`.
  - Migrating 0.1.x → 0.2.x: a `godot-bridge:` section in `settings.yaml` is **not** carried over, because DSH 0.2 imports leftover sections by plugin entry id and this plugin's row id is `tool-godot-bridge`. You do not have to re-enter it: when this runtime has no configured path, the plugin reads that section and writes the recorded value back through the same profile-patch path as the tool, so the engine build configured before the upgrade is used again. An already-configured value is never overwritten, and a recorded path that no longer exists on disk is ignored — that case keeps the `godot` on PATH fallback and logs a warning naming the dropped value.
- Port/host: hardcoded `127.0.0.1:9090` (matches the `McpInteractionServer` autoload default).
- Headless scripts: the plugin locates them relative to the module (`import.meta.url`); pass an explicit `ops_script` / `validate_script` argument to override.

## GUI field on DSH 0.2

DSH renders a bundle's configuration section only when a browser half registers the keyed slot `plugins.bundle.config` under the bundle's package name (a row's own form would take the keyed slot `plugins.row.config` under `<package name>#<row id>`, which opens one level deeper and is the right choice once a bundle has several independently configurable rows). This bundle ships that half (`client/client.js`, declared through `dsh.client` in its manifest) and registers `godot-bridge`, so opening the **godot-bridge** card on the Plugins page shows the `Godot engine path` field between the description and the row list, with a **Save** and a **Reset to default** for a path this profile overrides.

A save travels the same road as the rest of DSH's settings: it lands on the `tool-godot-bridge` row of this profile's `cordis.patch.yml`, which is exactly where `godot_set_engine_path` writes, so the field, that tool, and a hand-written `config:` block are three views of one value — and a change applies without a restart. Switching that row off withdraws the section with it, because the browser half belongs to that row.

On DSH 0.1.6–0.1.x the slot exists but the runtime has no settings-form service to read the value through, so the browser half registers nothing there and the card keeps the behaviour described under [Config](#config) above (no GUI field, use the tool or `settings.yaml`).

## Maintenance

- Editing `plugin/godot-bridge.mjs` needs no rebuild (plain ESM), and editing `client/client.js` needs no rebuild either: the host polls each bundle's artifact and hot-swaps it within about a second.
- After changing the plugin, reinstall it into the profile (`dsh plugin --profile web add github:Smalldy/godot-bridge` again) and restart the session. A `link:` install needs no reinstall — reload the profile (Plugins page) for host-half edits, and restart DSH after a `package.json` edit, whose `dsh.client`/`exports`/`files` facts are read once per Loader row and cached until restart.
- Before committing or publishing, run `npm run check` (static dependency contract: declared `@deepseek-ai/*` peers, bundle patch, entry exports). `node scripts/diagnose-dsh-resolution.mjs --profile <profile>` re-runs the launcher's resolution and prints what it routes (development only; needs the installed DSH app).
- The manifest's `peerDependencies` change what DSH may load: a declared `@deepseek-ai/dsh-*` range that does not match the running runtime makes DSH skip the bundle with an explicit message instead of failing at import.
- **Publishing an update**: bump `version` in `package.json` and push — the plugin's boot-time check (see README "Update notices") uses that version as the release marker, so existing installs only see a notice when it is higher than what they have.
- The game side (`mcp_interaction_server.gd` autoload) is never modified by the plugin.
