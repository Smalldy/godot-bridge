/**
 * godot-bridge — DSH ↔ Godot 运行时控制桥（标准 DSH 插件形态）
 * ==============================================================
 * 标准 DSH 插件：命名导出 name / inject / apply，工具经官方
 * @deepseek-ai/dsh-tools 的 defineTool 构造，通过 ctx.tools.register 注册。
 * 通过 `dsh plugin add` 安装（bundle 装进 profile 的 node_modules，
 * harness 启动时 heal 共享 @deepseek-ai/* 依赖层，因此可以正常 import）。
 *
 * 组合行（bundle cordis.patch.yml）：
 *   - id: tool-godot-bridge
 *     name: godot-bridge
 *
 * 注意：GODOT_PATH 默认读 <workspace>/.omp/mcp.json 的 env.GODOT_PATH，
 * 找不到用内置 gdvm 4.7.1 真实 exe 路径；务必用真实 exe，别用 shim。
 */

import { defineTool as defineToolOfficial } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'godot-bridge'

export const inject = ['subprocess', 'timer', 'tools', 'fs', 'sandboxPolicy', 'systemPrompt']

export function apply(ctx) {
  const subprocess = ctx.subprocess
  const timer = ctx.timer
  const tools = ctx.tools
  if (subprocess === undefined || timer === undefined || tools === undefined) return

  const PORT = 9090
  const FALLBACK_GODOT = 'C:/Users/74368/.gdvm/installs/registry.gdvm.io-7999f4302078c203/default/4.7.1-stable/Godot_v4.7.1-stable_win64.exe'

  // ── update notice state (best-effort; see checkForUpdate below) ──────────
  // The installed version comes from this bundle's own package.json; the
  // "latest" version is fetched from the repo's main branch package.json.
  // Forks: point `repository` in package.json at the fork and the check
  // follows it automatically (fallback: Smalldy/godot-bridge).
  let INSTALLED_VERSION = null
  let UPDATE_SOURCE = 'Smalldy/godot-bridge'
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    if (pkg && typeof pkg.version === 'string') INSTALLED_VERSION = pkg.version
    const repo = pkg && pkg.repository
    const repoUrl = typeof repo === 'string' ? repo : (repo && repo.url)
    if (typeof repoUrl === 'string') {
      const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.#]+)/)
      if (m) UPDATE_SOURCE = m[1] + '/' + m[2]
    }
  } catch (e) {}
  let updateState = { latest: null, available: false }

  let nodePath = null
  let godotPath = null
  let godot = null // { handle, outOffset, errOffset, projectPath, scene }
  let sessionWorkspace = null

  async function getNodePath() {
    if (nodePath) return nodePath
    try {
      nodePath = await subprocess.resolveExecutable('node')
    } catch (e) {
      nodePath = 'node'
    }
    return nodePath
  }

  async function getWorkspaceRoot(exec) {
    try {
      const policy = ctx.sandboxPolicy
      if (!policy) return null
      const resolved = exec && exec.agent
        ? policy.resolve({ session: exec.agent.session })
        : policy.resolve()
      if (resolved && typeof resolved.workspaceRoot === 'string' && resolved.workspaceRoot.length > 0) {
        sessionWorkspace = resolved.workspaceRoot
        return resolved.workspaceRoot
      }
    } catch (e) {}
    return null
  }

  // Godot exe: tool arg > .omp/mcp.json env > known gdvm 4.7.1 path.
  async function getGodotPath() {
    if (godotPath) return godotPath
    godotPath = FALLBACK_GODOT
    try {
      const fs = ctx.fs
      const root = await getWorkspaceRoot()
      if (fs !== undefined && root) {
        const target = await fs.resolve('.omp/mcp.json', { cwd: root })
        const text = await fs.readText(target)
        const parsed = JSON.parse(text)
        const server = parsed && parsed.mcpServers && parsed.mcpServers.godot
        if (server && server.env && server.env.GODOT_PATH) {
          godotPath = server.env.GODOT_PATH
        }
      }
    } catch (e) {}
    return godotPath
  }

  // ── update notice: best-effort version check ─────────────────────────────
  // Parses "x.y.z" into comparable numbers; returns null for anything else.
  function parseVersion(v) {
    const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/)
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null
  }

  function isNewer(latest, installed) {
    const a = parseVersion(latest)
    const b = parseVersion(installed)
    if (!a || !b) return false
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] > b[i]
    }
    return false
  }

  // Fetch the repo's main-branch package.json version through a one-shot
  // `node -e` (Node ≥18 global fetch; no git or extra dependency needed).
  // Never throws; returns null on any failure (offline, non-200, timeout).
  async function fetchLatestVersion() {
    try {
      const url = 'https://raw.githubusercontent.com/' + UPDATE_SOURCE + '/main/package.json'
      const node = await getNodePath()
      const ac = new AbortController()
      const timerHandle = setTimeout(function () { ac.abort() }, 5000)
      let handle
      try {
        handle = subprocess.spawn({
          argv: [
            node, '-e',
            "fetch(process.argv[1]).then(function(r){if(!r.ok){throw new Error(String(r.status));}return r.json();}).then(function(j){process.stdout.write(String(j.version||''));}).catch(function(){process.exit(1);});",
            url,
          ],
          cwd: '.',
          stdio: {
            stdin: 'ignore',
            stdout: { collect: { maxBytes: 1024 * 1024 } },
            stderr: 'ignore',
          },
          graceMs: 1000,
          signal: ac.signal,
        })
      } catch (e) {
        clearTimeout(timerHandle)
        return null
      }
      try {
        await handle.done
      } catch (e) {
        clearTimeout(timerHandle)
        return null
      }
      clearTimeout(timerHandle)
      let text = ''
      try {
        if (handle.collected && handle.collected.stdout) {
          text = handle.collected.stdout.readFrom(0).text || ''
        }
      } catch (e) {}
      const v = text.trim()
      return v.length > 0 ? v : null
    } catch (e) {
      return null
    }
  }

  // Fire-and-forget: never delays boot and never fails the plugin. When a
  // newer version exists it registers a global system-prompt section with an
  // imperative instruction, so the model surfaces the notice in every session
  // until the plugin is updated.
  ;(async function checkForUpdate() {
    try {
      const latest = await fetchLatestVersion()
      if (latest && isNewer(latest, INSTALLED_VERSION)) {
        updateState.latest = latest
        updateState.available = true
        try {
          const systemPrompt = ctx.systemPrompt
          if (systemPrompt) {
            ctx.effect(function () {
              return systemPrompt.section({
                name: 'godot-bridge:update',
                order: 90,
                text: 'IMPORTANT - you must inform the user: godot-bridge has an update available (installed '
                  + (INSTALLED_VERSION || '?') + ', latest ' + latest
                  + '). Tell them to run `dsh plugin --profile web update godot-bridge` and restart DSH. '
                  + '重要 - 你必须告知用户：godot-bridge 有可用更新（已装 ' + (INSTALLED_VERSION || '?')
                  + '，最新 ' + latest + '）。请用户执行 `dsh plugin --profile web update godot-bridge` 并重启 DSH。',
              })
            })
            try {
              console.log('[godot-bridge] update notice registered: ' + (INSTALLED_VERSION || '?') + ' -> ' + latest)
            } catch (e) {}
          }
        } catch (e) {
          try {
            console.log('[godot-bridge] update notice registration failed: ' + ((e && e.message) || e))
          } catch (e2) {}
        }
      }
    } catch (e) {}
  })()

  // One-shot node bridge: connect to the in-game TCP server, send one
  // newline-delimited JSON command, print the first complete response line.
  // NOTE: with `node -e <script> <cmd> <paramsJson> <timeoutMs>`, the extra
  // args land at process.argv[1..3] (argv[0] is node itself).
  const BRIDGE = [
    "var NL=String.fromCharCode(10);",
    "var net=require('net');",
    "var cmd=process.argv[1]||'';",
    "var params={};",
    "try{params=JSON.parse(process.argv[2]||'{}');}catch(e){}",
    "var to=parseInt(process.argv[3]||'20000',10);if(!(to>0)){to=20000;}",
    "var sock=net.connect(9090,'127.0.0.1');",
    "var buf='',done=false;",
    "function fin(obj){if(done){return;}done=true;clearTimeout(t);try{sock.destroy();}catch(e){}process.stdout.write(JSON.stringify(obj));}",
    "var t=setTimeout(function(){fin({error:'bridge timeout'});},to);",
    "sock.on('connect',function(){sock.write(JSON.stringify({command:cmd,params:params,id:1})+NL);});",
    "sock.on('data',function(d){buf+=d.toString();for(;;){var i=buf.indexOf(NL);if(i<0){break;}var line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line){continue;}try{fin(JSON.parse(line));return;}catch(e){}}});",
    "sock.on('error',function(e){fin({error:'tcp:'+e.message});});",
    "sock.on('close',function(){fin({error:'connection closed'});});",
  ].join('')

  async function runGameCommand(command, params, timeoutMs, signal) {
    const node = await getNodePath()
    const root = await getWorkspaceRoot()
    let handle
    try {
      handle = subprocess.spawn({
        argv: [node, '-e', BRIDGE, String(command), JSON.stringify(params || {}), String(timeoutMs || 20000)],
        cwd: root || '.',
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: 8 * 1024 * 1024 } },
          stderr: 'inherit',
        },
        graceMs: 3000,
        signal: signal,
      })
    } catch (e) {
      return { error: 'bridge spawn failed: ' + (e && e.message) }
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (e) {
      return { error: 'bridge spawn failed: ' + (e && e.message) }
    }
    let text = ''
    try {
      if (handle.collected && handle.collected.stdout) {
        text = handle.collected.stdout.readFrom(0).text || ''
      }
    } catch (e) {}
    const line = text.split('\n')[0].trim()
    if (!line) return { error: 'no response from bridge (exit ' + outcome.exitCode + ')' }
    try {
      return JSON.parse(line)
    } catch (e) {
      return { error: 'unparsable bridge output', raw: line.slice(0, 500) }
    }
  }

  async function waitForGame(signal, maxMs) {
    const start = Date.now()
    await ctx.timeout(1500)
    while (Date.now() - start < maxMs) {
      if (signal && signal.aborted) return false
      const resp = await runGameCommand('get_performance', {}, 4000, signal)
      if (resp && !resp.error) return true
      await ctx.timeout(800)
    }
    return false
  }

  // ── headless static operations (godot_operations.gd / validate_script.gd) ──

  async function resolveScriptFile(name, explicit) {
    if (explicit) return explicit
    try {
      if (typeof import.meta !== 'undefined' && import.meta.url) {
        const u = new URL('./' + name, import.meta.url)
        return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1')
      }
    } catch (e) {}
    return name
  }

  async function runHeadless(godotExe, projectPath, scriptPath, extraArgs, signal) {
    const argv = [godotExe, '--headless', '--path', projectPath, '--script', scriptPath].concat(extraArgs)
    let handle
    try {
      handle = subprocess.spawn({
        argv: argv,
        cwd: projectPath,
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: 8 * 1024 * 1024 } },
          stderr: { collect: { maxBytes: 8 * 1024 * 1024 } },
        },
        graceMs: 3000,
        signal: signal,
      })
    } catch (e) {
      return { out: '', err: '', exitCode: -1, spawnError: String((e && e.message) || e) }
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (e) {
      return { out: '', err: '', exitCode: -1, spawnError: String((e && e.message) || e) }
    }
    let out = ''
    let err = ''
    try {
      if (handle.collected && handle.collected.stdout) out = handle.collected.stdout.readFrom(0).text || ''
      if (handle.collected && handle.collected.stderr) err = handle.collected.stderr.readFrom(0).text || ''
    } catch (e) {}
    return { out: out, err: err, exitCode: outcome.exitCode }
  }

  // ── Godot project-edit helpers (pure file logic + Godot format knowledge) ──

  async function ensureDir(dir) {
    if (!dir) return
    try {
      const node = await getNodePath()
      const h = subprocess.spawn({
        argv: [node, '-e', "require('fs').mkdirSync(process.argv[1], { recursive: true })", dir],
        cwd: dir,
        stdio: { stdin: 'ignore', stdout: { collect: { maxBytes: 1024 * 1024 } }, stderr: 'inherit' },
        graceMs: 3000,
      })
      await h.done
    } catch (e) {}
  }

  async function readProjectFile(projectPath, filename) {
    try {
      const fs = ctx.fs
      const target = await fs.resolve(filename, { cwd: projectPath })
      const info = await fs.stat(target)
      if (!info) return null
      return await fs.readText(target)
    } catch (e) {
      return null
    }
  }

  async function writeProjectFile(projectPath, filename, content) {
    const fs = ctx.fs
    const target = await fs.resolve(filename, { cwd: projectPath })
    // The fs service applies the DEPLOYMENT default policy unless one is
    // passed; without it, writes inside the session workspace are denied when
    // the deployment root differs. Pass the session policy explicitly (same
    // resolution the pwsh tool uses).
    const policy = sessionWorkspace
      ? { mode: 'workspace-write', workspaceRoot: sessionWorkspace }
      : undefined
    await fs.writeText(target, content, undefined, undefined, policy)
    return true
  }

  // Extract one `[section]` block (up to the next `[section]` or EOF).
  function getSection(content, section) {
    const re = new RegExp('\\[' + section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]([\\s\\S]*?)(?=\\n\\[|$)')
    const m = content.match(re)
    return m ? m[1] : null
  }

  // Set `key=value` inside a section; creates the section when missing.
  function setSectionKey(content, section, key, value) {
    const header = '[' + section + ']'
    const keyLine = key + '=' + value
    const idx = content.indexOf(header)
    if (idx === -1) return content.replace(/\s*$/, '') + '\n\n' + header + '\n\n' + keyLine + '\n'
    const sectionEndRel = content.indexOf('\n[', idx + header.length)
    const sectionEnd = sectionEndRel === -1 ? content.length : sectionEndRel
    const block = content.slice(idx, sectionEnd)
    const keyRe = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=.*$', 'm')
    let newBlock
    if (keyRe.test(block)) newBlock = block.replace(keyRe, keyLine)
    else newBlock = block.replace(/\s*$/, '') + '\n' + keyLine
    return content.slice(0, idx) + newBlock + content.slice(sectionEnd)
  }

  // Remove `key=` lines inside a section.
  function removeSectionKey(content, section, key) {
    const header = '[' + section + ']'
    const idx = content.indexOf(header)
    if (idx === -1) return content
    const sectionEndRel = content.indexOf('\n[', idx + header.length)
    const sectionEnd = sectionEndRel === -1 ? content.length : sectionEndRel
    const block = content.slice(idx, sectionEnd)
    const keyRe = new RegExp('\\n?' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=.*', 'g')
    const newBlock = block.replace(keyRe, '')
    return content.slice(0, idx) + newBlock + content.slice(sectionEnd)
  }

  // Serialize a JSON value into Godot's project.godot value syntax.
  function serializeGodotValue(value, type) {
    if (type === 'string' || (type === undefined && typeof value === 'string')) {
      return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    }
    if (type === 'string_array' || (type === undefined && Array.isArray(value))) {
      return 'PackedStringArray(' + value.map(function (s) { return '"' + String(s).replace(/"/g, '\\"') + '"' }).join(', ') + ')'
    }
    if (type === 'bool' || (type === undefined && typeof value === 'boolean')) return value ? 'true' : 'false'
    if (type === 'vector2i') {
      const p = value && typeof value === 'object' ? value : {}
      return 'Vector2i(' + (p.x || 0) + ', ' + (p.y || 0) + ')'
    }
    return String(value)
  }

  // Godot 4 physical keycodes (KEY_SPECIAL = 4194304; ASCII keys are their ASCII value).
  // godot-mcp used the Godot 3 baseline (16777216) here, silently breaking special-key bindings.
  const GODOT_KEYCODES = {
    'SPACE': 32, 'ENTER': 4194309, 'RETURN': 4194309, 'ESCAPE': 4194305, 'ESC': 4194305,
    'TAB': 4194306, 'CAPSLOCK': 4194307, 'CAPS_LOCK': 4194307, 'BACKSPACE': 4194308,
    'INSERT': 4194310, 'DELETE': 4194311, 'HOME': 4194312, 'END': 4194313,
    'PAGEUP': 4194314, 'PAGE_UP': 4194314, 'PAGEDOWN': 4194315, 'PAGE_DOWN': 4194315,
    'LEFT': 4194319, 'UP': 4194320, 'RIGHT': 4194321, 'DOWN': 4194322,
    'SHIFT': 4194325, 'CTRL': 4194326, 'CONTROL': 4194326, 'META': 4194327, 'ALT': 4194328,
    'F1': 4194332, 'F2': 4194333, 'F3': 4194334, 'F4': 4194335, 'F5': 4194336, 'F6': 4194337,
    'F7': 4194338, 'F8': 4194339, 'F9': 4194340, 'F10': 4194341, 'F11': 4194342, 'F12': 4194343,
  }

  function keyToGodotKeycode(key) {
    if (!key) return 0
    const upper = String(key).toUpperCase()
    if (GODOT_KEYCODES[upper]) return GODOT_KEYCODES[upper]
    if (upper.length === 1) return upper.charCodeAt(0)
    return 0
  }

  function inputEventObject(keycode) {
    return 'Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,'
      + '"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,'
      + '"keycode":0,"physical_keycode":' + keycode + ',"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)'
  }

  // Headless Godot without --script (e.g. export): godot --headless --path <p> <extraArgs>.
  async function runGodotHeadless(godotExe, projectPath, extraArgs, signal) {
    const argv = [godotExe, '--headless', '--path', projectPath].concat(extraArgs)
    let handle
    try {
      handle = subprocess.spawn({
        argv: argv,
        cwd: projectPath,
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: 8 * 1024 * 1024 } },
          stderr: { collect: { maxBytes: 8 * 1024 * 1024 } },
        },
        graceMs: 3000,
        signal: signal,
      })
    } catch (e) {
      return { out: '', err: '', exitCode: -1, spawnError: String((e && e.message) || e) }
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (e) {
      return { out: '', err: '', exitCode: -1, spawnError: String((e && e.message) || e) }
    }
    let out = ''
    let err = ''
    try {
      if (handle.collected && handle.collected.stdout) out = handle.collected.stdout.readFrom(0).text || ''
      if (handle.collected && handle.collected.stderr) err = handle.collected.stderr.readFrom(0).text || ''
    } catch (e) {}
    return { out: out, err: err, exitCode: outcome.exitCode }
  }

  // Official-shape wrapper: the defs below still carry the legacy
  // { type:'object', properties, required:[] } parameter shape; convert to the
  // official per-property map ({ prop: { ..., required: true } }) and let
  // @deepseek-ai/dsh-tools' defineTool build the registry-ready definition.
  function defineTool(opt) {
    const parameters = {}
    const required = opt.required || []
    for (const key of Object.keys(opt.properties || {})) {
      const spec = Object.assign({}, opt.properties[key])
      if (required.includes(key)) spec.required = true
      parameters[key] = spec
    }
    const def = {
      name: opt.name,
      description: opt.description,
      parameters: parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: function (_args, value) {
          return [{ type: 'text', text: JSON.stringify(value) }]
        },
      },
    }
    if (opt.timeoutMs) def.timeoutMs = opt.timeoutMs
    def.execute = async function (args, exec) {
      try {
        return await opt.execute(args, exec)
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    }
    return defineToolOfficial(def)
  }

  const COMMANDS = [
    'screenshot', 'click', 'key_press', 'eval', 'wait', 'mouse_move',
    'get_ui_elements', 'get_scene_tree', 'get_property', 'set_property',
    'call_method', 'get_node_info', 'instantiate_scene', 'remove_node',
    'change_scene', 'pause', 'get_performance', 'connect_signal',
    'disconnect_signal', 'emit_signal', 'play_animation', 'tween_property',
    'get_nodes_in_group', 'find_nodes_by_class', 'reparent_node', 'key_hold',
    'key_release', 'scroll', 'mouse_drag', 'gamepad', 'get_camera',
    'set_camera', 'raycast', 'get_audio', 'spawn_node', 'set_shader_param',
    'audio_play', 'audio_bus', 'navigate_path', 'tilemap', 'add_collision',
    'environment', 'manage_group', 'create_timer', 'set_particles',
    'create_animation', 'serialize_state', 'physics_body', 'create_joint',
    'bone_pose', 'ui_theme', 'viewport', 'debug_draw', 'http_request',
    'websocket', 'multiplayer', 'rpc', 'touch', 'input_state', 'input_action',
    'list_signals', 'await_signal', 'script', 'window', 'os_info', 'time_scale',
    'process_mode', 'world_settings', 'csg', 'multimesh', 'procedural_mesh',
    'light_3d', 'mesh_instance', 'gridmap', '3d_effects', 'gi', 'path_3d',
    'sky', 'camera_attributes', 'navigation_3d', 'physics_3d', 'canvas',
    'canvas_draw', 'light_2d', 'parallax', 'shape_2d', 'path_2d', 'physics_2d',
    'animation_tree', 'animation_control', 'skeleton_ik', 'audio_effect',
    'audio_bus_layout', 'audio_spatial', 'locale', 'ui_control', 'ui_text',
    'ui_popup', 'ui_tree', 'ui_item_list', 'ui_tabs', 'ui_menu', 'ui_range',
    'render_settings', 'resource', 'video', 'terrain',
  ]

  const HEADLESS_OPS = [
    'create_scene', 'add_node', 'load_sprite', 'export_mesh_library',
    'save_scene', 'get_uid', 'resave_resources', 'read_scene',
    'modify_node', 'remove_node', 'attach_script', 'create_resource',
    'manage_resource', 'manage_scene_signals', 'manage_theme_resource',
    'manage_scene_structure',
  ]

  const defs = [
    defineTool({
      name: 'godot_ping',
      description: 'Probe whether the running Godot game accepts commands on the in-game interaction server (TCP 127.0.0.1:9090). Returns game_running plus the probe detail. Use before game commands when unsure the game is up.',
      properties: {
        timeout_ms: { type: 'number', description: 'Probe timeout in ms (default 5000)' },
      },
      async execute(args, exec) {
        const resp = await runGameCommand('get_performance', {}, args.timeout_ms || 5000, exec.signal)
        return {
          game_running: !(resp && resp.error),
          port: PORT,
          plugin_version: INSTALLED_VERSION,
          latest_version: updateState.latest,
          update_available: updateState.available,
          detail: resp,
        }
      },
    }),

    defineTool({
      name: 'godot_run_project',
      description: 'Launch the Godot project in debug mode (godot -d --path <project>) and wait for the in-game interaction server. The project must register the McpInteractionServer autoload (mcp_interaction_server.gd). Returns process info and game_ready.',
      properties: {
        project_path: { type: 'string', description: 'Path to the Godot project (default: current session workspace)' },
        scene: { type: 'string', description: 'Optional scene to run relative to the project, e.g. scenes/main/main_menu.tscn' },
        godot_path: { type: 'string', description: 'Godot executable. Default: GODOT_PATH from .omp/mcp.json, else the known gdvm 4.7.1 path. Use the REAL exe full path - never the gdvm shim.' },
        debug: { type: 'boolean', description: 'Run with -d (debug mode). Default true.' },
        wait_ms: { type: 'number', description: 'How long to wait for the interaction server before giving up (default 20000)' },
      },
      timeoutMs: 60000,
      async execute(args, exec) {
        const root = await getWorkspaceRoot(exec)
        const projectPath = args.project_path || root
        if (!projectPath) return { error: 'project_path is required (workspace root unavailable)' }
        if (godot) {
          try {
            godot.handle.terminate()
            await godot.handle.waitForExit(exec.signal)
          } catch (e) {}
          godot = null
        }
        const gp = args.godot_path || await getGodotPath()
        const argv = [gp]
        if (args.debug !== false) argv.push('-d')
        argv.push('--path', projectPath)
        if (args.scene) argv.push(String(args.scene))
        let handle
        try {
          handle = subprocess.spawn({
            argv: argv,
            cwd: projectPath,
            stdio: {
              stdin: 'ignore',
              stdout: { collect: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 32 * 1024 * 1024 } } },
              stderr: { collect: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 32 * 1024 * 1024 } } },
            },
            graceMs: 3000,
            signal: exec.signal,
          })
        } catch (e) {
          return { error: 'failed to spawn Godot: ' + (e && e.message) }
        }
        godot = { handle: handle, outOffset: 0, errOffset: 0, projectPath: projectPath, scene: args.scene || null }
        const ready = await waitForGame(exec.signal, args.wait_ms || 20000)
        return {
          pid: handle.pid,
          project_path: projectPath,
          godot_path: gp,
          scene: args.scene || null,
          game_ready: ready,
          port: PORT,
          note: ready
            ? 'Game interaction server reachable on 127.0.0.1:9090'
            : 'Game process started but the interaction server did not answer in time; call godot_get_debug_output to diagnose',
        }
      },
    }),

    defineTool({
      name: 'godot_stop_project',
      description: 'Terminate the Godot process started by godot_run_project (tree-scoped kill, like MCP stop_project).',
      properties: {},
      async execute(args, exec) {
        if (!godot) return { stopped: false, reason: 'no Godot process was started by this plugin' }
        const pid = godot.handle.pid
        const projectPath = godot.projectPath
        godot.handle.terminate()
        try {
          await godot.handle.waitForExit(exec.signal)
        } catch (e) {}
        godot = null
        return { stopped: true, pid: pid, project_path: projectPath }
      },
    }),

    defineTool({
      name: 'godot_get_debug_output',
      description: 'Read stdout/stderr collected from the Godot process launched by godot_run_project. Incremental: returns only output new since the previous call.',
      properties: {},
      async execute(args, exec) {
        if (!godot) return { running: false, reason: 'no Godot process started by this plugin' }
        let out = ''
        let err = ''
        const collected = godot.handle.collected
        if (collected && collected.stdout) {
          const r = collected.stdout.readFrom(godot.outOffset)
          out = r.text
          godot.outOffset = r.nextOffset
        }
        if (collected && collected.stderr) {
          const r = collected.stderr.readFrom(godot.errOffset)
          err = r.text
          godot.errOffset = r.nextOffset
        }
        return { running: true, pid: godot.handle.pid, stdout: out, stderr: err }
      },
    }),

    defineTool({
      name: 'godot_command',
      description: 'Send one command to the running Godot game via its in-game interaction server (McpInteractionServer autoload on TCP 127.0.0.1:9090). The game must be running (godot_run_project, or started manually - the autoload always listens). Returns the game response JSON verbatim. Core commands: get_scene_tree (scene graph), get_ui_elements (visible UI with positions), screenshot (PNG base64), eval (run GDScript, return value), get_property / set_property / call_method / get_node_info (inspect & mutate nodes), click / key_press / key_hold / key_release / mouse_move / scroll (input), play_animation / tween_property, get_performance, pause, change_scene, instantiate_scene, remove_node, connect_signal / emit_signal / await_signal, raycast, spawn_node, serialize_state, and more.',
      required: ['command'],
      properties: {
        command: { type: 'string', enum: COMMANDS, description: 'Command to execute in the game' },
        params: { type: 'object', additionalProperties: true, description: 'Command parameters as documented for that command (node_path, property, code, x/y, etc.)' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 15000; async commands like screenshot/eval/await_signal may need more)' },
      },
      timeoutMs: 40000,
      async execute(args, exec) {
        return await runGameCommand(args.command, args.params || {}, args.timeout_ms || 15000, exec.signal)
      },
    }),

    defineTool({
      name: 'godot_screenshot',
      description: 'Capture the current game viewport as a PNG. Returns { success, width, height, data } where data is the base64-encoded PNG. Save and decode it to view the game state.',
      properties: {},
      timeoutMs: 40000,
      async execute(args, exec) {
        const resp = await runGameCommand('screenshot', {}, 20000, exec.signal)
        if (resp && resp.success) return resp
        return { error: (resp && resp.error) || 'screenshot failed' }
      },
    }),

    defineTool({
      name: 'godot_headless_op',
      description: 'Run a headless Godot static operation (no running game needed): spawns `godot --headless --path <project> --script godot_operations.gd <operation> <paramsJson>`. Operations: create_scene, add_node, load_sprite, export_mesh_library, save_scene, get_uid, resave_resources, read_scene (parse a .tscn to JSON), modify_node, remove_node, attach_script, create_resource, manage_resource, manage_scene_signals, manage_theme_resource, manage_scene_structure.',
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: HEADLESS_OPS, description: 'Operation to run' },
        params: { type: 'object', additionalProperties: true, description: 'Operation parameters (project-relative paths; see godot_operations.gd)' },
        project_path: { type: 'string', description: 'Godot project path (default: current session workspace)' },
        godot_path: { type: 'string', description: 'Godot executable (default: same resolution as godot_run_project)' },
        ops_script: { type: 'string', description: 'Override path to godot_operations.gd' },
      },
      timeoutMs: 60000,
      async execute(args, exec) {
        const root = await getWorkspaceRoot(exec)
        const projectPath = args.project_path || root
        if (!projectPath) return { error: 'project_path is required (workspace root unavailable)' }
        const gp = args.godot_path || await getGodotPath()
        const ops = await resolveScriptFile('godot_operations.gd', args.ops_script)
        const res = await runHeadless(gp, projectPath, ops, [String(args.operation), JSON.stringify(args.params || {})], exec.signal)
        if (res.spawnError) return { error: 'headless spawn failed: ' + res.spawnError }
        const text = (res.out || '').trim()
        let parsed = null
        let producedJson = false
        const sj = text.indexOf('SCENE_JSON_START')
        if (sj >= 0) {
          producedJson = true
          const start = sj + 'SCENE_JSON_START'.length
          const end = text.indexOf('SCENE_JSON_END', start)
          if (end > start) {
            const raw = text.slice(start, end).trim()
            try { parsed = JSON.parse(raw) } catch (e) {}
          }
        }
        if (parsed === null && text && (text[0] === '{' || text[0] === '[')) {
          try { parsed = JSON.parse(text) } catch (e) {}
        }
        // stderr may carry benign dependency-load warnings (scene scripts
        // referencing autoloads fail to compile in headless script mode);
        // fail only when the operation produced no usable output.
        const failed = res.err.indexOf('Failed to') >= 0 && !producedJson && parsed === null
        return {
          success: !failed && res.exitCode === 0,
          operation: args.operation,
          project_path: projectPath,
          exit_code: res.exitCode,
          output: parsed !== null ? parsed : res.out,
          stderr: res.err,
        }
      },
    }),

    defineTool({
      name: 'godot_validate_script',
      description: 'Headlessly compile-check one GDScript file: `godot --headless --path <project> --script validate_script.gd <res://path>`. Returns { valid, script_path, error_count, errors: [{message, file, line}] }.',
      required: ['script_path'],
      properties: {
        script_path: { type: 'string', description: 'GDScript path relative to project, e.g. scripts/player.gd' },
        project_path: { type: 'string', description: 'Godot project path (default: current session workspace)' },
        godot_path: { type: 'string', description: 'Godot executable (default: same resolution as godot_run_project)' },
        validate_script: { type: 'string', description: 'Override path to validate_script.gd' },
      },
      timeoutMs: 60000,
      async execute(args, exec) {
        const root = await getWorkspaceRoot(exec)
        const projectPath = args.project_path || root
        if (!projectPath) return { error: 'project_path is required (workspace root unavailable)' }
        const scriptPath = String(args.script_path || '')
        if (!/\.gd$/i.test(scriptPath)) return { error: 'validate_script only checks GDScript (.gd) files' }
        const gp = args.godot_path || await getGodotPath()
        const vs = await resolveScriptFile('validate_script.gd', args.validate_script)
        const res = await runHeadless(gp, projectPath, vs, ['res://' + scriptPath.replace(/^res:\/\//, '')], exec.signal)
        if (res.spawnError) return { error: 'headless spawn failed: ' + res.spawnError }
        const errors = []
        const lines = (res.err || '').split(/\r?\n/)
        const locRe = /\((res:\/\/.+):(\d+)\)/
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/SCRIPT ERROR:\s*(.+?)\s*$/)
          if (!m) continue
          const message = m[1].replace(/^Parse Error:\s*/, '')
          let file
          let line
          for (const j of [i + 1, i]) {
            if (j >= lines.length) continue
            const loc = lines[j].match(locRe)
            if (loc) { file = loc[1]; line = parseInt(loc[2], 10); break }
          }
          errors.push({ message: message, file: file, line: line })
        }
        return { valid: errors.length === 0, script_path: scriptPath, error_count: errors.length, errors: errors }
      },
    }),

    defineTool({
      name: 'godot_set_project_setting',
      description: 'Set one key inside a project.godot section (creates the section when missing). Covers modify_project_settings; set_main_scene (application / run/main_scene); manage_layers (layer_names / 2d_render/layer_1); manage_plugins (editor_plugins / enabled); manage_translations (internationalization / ...). value_type serializes the JSON value into Godot syntax: string (quoted), string_array (PackedStringArray), bool, int/float, vector2i; raw passes it through unchanged.',
      required: ['section', 'key', 'value'],
      properties: {
        section: { type: 'string', description: 'project.godot section, e.g. application, rendering, layer_names, editor_plugins, internationalization' },
        key: { type: 'string', description: 'Setting key inside the section, e.g. run/main_scene, 2d_render/layer_1' },
        value: { type: 'string', description: 'Value: JSON (e.g. ["a","b"] for string_array, true, 5) or plain text' },
        value_type: { type: 'string', enum: ['auto', 'raw', 'string', 'bool', 'int', 'float', 'string_array', 'vector2i'], description: 'How to serialize value (default auto-detects JSON)' },
        project_path: { type: 'string', description: 'Godot project path (default: current session workspace)' },
      },
      async execute(args, exec) {
        const root = await getWorkspaceRoot(exec)
        const projectPath = args.project_path || root
        if (!projectPath) return { error: 'project_path is required (workspace root unavailable)' }
        const content = await readProjectFile(projectPath, 'project.godot')
        if (content === null) return { error: 'project.godot not found at ' + projectPath }
        let parsedValue = args.value
        if (args.value_type !== 'raw') {
          try { parsedValue = JSON.parse(args.value) } catch (e) { parsedValue = args.value }
        }
        const type = args.value_type === 'auto' ? undefined : args.value_type
        const line = serializeGodotValue(parsedValue, type)
        const next = setSectionKey(content, args.section, args.key, line)
        try {
          await writeProjectFile(projectPath, 'project.godot', next)
        } catch (e) {
          return { error: 'write failed: ' + String((e && e.message) || e) }
        }
        return { success: true, section: args.section, key: args.key, value: line, project_path: projectPath }
      },
    }),

    defineTool({
      name: 'godot_manage_autoloads',
      description: 'List / add / remove autoload singletons in project.godot. Add writes Name="*res://path.gd" (the "*" prefix marks the singleton enabled).',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'Operation' },
        name: { type: 'string', description: 'Autoload singleton name (add/remove)' },
        script_path: { type: 'string', description: 'Script path with res:// prefix (add), e.g. res://autoload/game_state.gd' },
        enabled: { type: 'boolean', description: 'Singleton enabled ("*" prefix). Default true.' },
        project_path: { type: 'string', description: 'Godot project path (default: current session workspace)' },
      },
      async execute(args, exec) {
        const root = await getWorkspaceRoot(exec)
        const projectPath = args.project_path || root
        if (!projectPath) return { error: 'project_path is required (workspace root unavailable)' }
        const content = await readProjectFile(projectPath, 'project.godot')
        if (content === null) return { error: 'project.godot not found at ' + projectPath }
        if (args.action === 'list') {
          const block = getSection(content, 'autoload')
          const autoloads = {}
          if (block) {
            for (const raw of block.split('\n')) {
              const kv = raw.trim().match(/^([^=]+)=(.*)$/)
              if (kv) autoloads[kv[1].trim()] = kv[2].trim()
            }
          }
          return { success: true, autoloads: autoloads }
        }
        if (!args.name) return { error: 'name is required for add/remove' }
        if (args.action === 'add') {
          if (!args.script_path) return { error: 'script_path is required for add' }
          const star = args.enabled === false ? '' : '*'
          const value = '"' + star + String(args.script_path) + '"'
          const next = setSectionKey(content, 'autoload', args.name, value)
          try {
            await writeProjectFile(projectPath, 'project.godot', next)
          } catch (e) {
            return { error: 'write failed: ' + String((e && e.message) || e) }
          }
          return { success: true, name: args.name, path: star + args.script_path }
        }
        const next = removeSectionKey(content, 'autoload', args.name)
        try {
          await writeProjectFile(projectPath, 'project.godot', next)
        } catch (e) {
          return { error: 'write failed: ' + String((e && e.message) || e) }
        }
        return { success: true, name: args.name, removed: true }
      },
    }),

    defineTool({
      name: 'godot_manage_input_map',
      description: 'List / add / remove input actions in project.godot [input]. Add serializes an InputEventKey with the correct Godot 4 physical_keycode (KEY_SPECIAL=4194304; ASCII keys use their ASCII value) — godot-mcp used the Godot 3 baseline (16777216), which silently broke special-key bindings.',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'Operation' },
        action_name: { type: 'string', description: 'Input action name (add/remove), e.g. jump' },
        key: { type: 'string', description: 'Key name for add, e.g. W, SPACE, ENTER, SHIFT, F3' },
        keycode: { type: 'number', description: 'Explicit physical_keycode override (overrides key)' },
        deadzone: { type: 'number', description: 'Action deadzone (default 0.5)' },
        project_path: { type: 'string', description: 'Godot project path (default: current session workspace)' },
      },
      async execute(args, exec) {
        const root = await getWorkspaceRoot(exec)
        const projectPath = args.project_path || root
        if (!projectPath) return { error: 'project_path is required (workspace root unavailable)' }
        const content = await readProjectFile(projectPath, 'project.godot')
        if (content === null) return { error: 'project.godot not found at ' + projectPath }
        if (args.action === 'list') {
          const block = getSection(content, 'input')
          const actions = {}
          if (block) {
            for (const raw of block.split('\n')) {
              const kv = raw.trim().match(/^([^=]+)=(.*)$/)
              if (kv) actions[kv[1].trim()] = kv[2].trim()
            }
          }
          return { success: true, actions: actions }
        }
        if (!args.action_name) return { error: 'action_name is required for add/remove' }
        if (args.action === 'add') {
          const deadzone = args.deadzone !== undefined ? args.deadzone : 0.5
          const keycode = args.keycode !== undefined ? args.keycode : keyToGodotKeycode(args.key)
          if (!keycode) return { error: 'unknown key: ' + args.key + ' (pass keycode explicitly)' }
          const evt = inputEventObject(keycode)
          const esc = args.action_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const blockRe = new RegExp('^' + esc + '\\s*=\\s*\\{[\\s\\S]*?\\}\\s*$', 'm')
          let next
          const existing = content.match(blockRe)
          if (existing) {
            const block = existing[0]
            const dzMatch = block.match(/"deadzone"\s*:\s*([\d.eE+-]+)/)
            const dz = dzMatch ? dzMatch[1] : String(deadzone)
            const eventsMatch = block.match(/"events"\s*:\s*\[([\s\S]*)\]\s*\}\s*$/)
            const existingEvents = eventsMatch ? eventsMatch[1] : ''
            let merged = existingEvents
            const dup = new RegExp('"physical_keycode"\\s*:\\s*' + keycode + '\\b')
            if (!dup.test(existingEvents)) {
              merged = existingEvents.trim().length > 0 ? existingEvents + ', ' + evt : evt
            }
            const newBlock = merged.trim().length > 0
              ? args.action_name + '={"deadzone": ' + dz + ', "events": [' + merged + ']}'
              : args.action_name + '={"deadzone": ' + dz + '}'
            next = content.replace(blockRe, newBlock)
          } else {
            next = setSectionKey(content, 'input', args.action_name,
              '{"deadzone": ' + deadzone + ', "events": [' + evt + ']}')
          }
          try {
            await writeProjectFile(projectPath, 'project.godot', next)
          } catch (e) {
            return { error: 'write failed: ' + String((e && e.message) || e) }
          }
          return { success: true, action: args.action_name, keycode: keycode, note: 'Godot 4 physical_keycode (KEY_SPECIAL=4194304)' }
        }
        const next = removeSectionKey(content, 'input', args.action_name)
        try {
          await writeProjectFile(projectPath, 'project.godot', next)
        } catch (e) {
          return { error: 'write failed: ' + String((e && e.message) || e) }
        }
        return { success: true, action: args.action_name, removed: true }
      },
    }),

    defineTool({
      name: 'godot_manage_export_presets',
      description: 'List / add / remove export presets in export_presets.cfg. Add creates a bare [preset.<ts>] block with name/platform/runnable; fill in the platform options manually afterwards (or use the editor).',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'Operation' },
        name: { type: 'string', description: 'Preset name (add/remove)' },
        platform: { type: 'string', description: 'Platform id for add, e.g. Windows Desktop, Linux, macOS, Web' },
        runnable: { type: 'boolean', description: 'runnable flag (default false)' },
        project_path: { type: 'string', description: 'Godot project path (default: current session workspace)' },
      },
      async execute(args, exec) {
        const root = await getWorkspaceRoot(exec)
        const projectPath = args.project_path || root
        if (!projectPath) return { error: 'project_path is required (workspace root unavailable)' }
        if (args.action === 'list') {
          const content = await readProjectFile(projectPath, 'export_presets.cfg')
          if (content === null) return { success: true, presets: [] }
          const presets = []
          const names = Array.from(content.matchAll(/name="([^"]+)"/g), function (m) { return m[1] })
          const platforms = Array.from(content.matchAll(/platform="([^"]+)"/g), function (m) { return m[1] })
          for (let i = 0; i < names.length; i++) presets.push({ name: names[i], platform: platforms[i] || 'unknown' })
          return { success: true, presets: presets }
        }
        if (args.action === 'add') {
          if (!args.name || !args.platform) return { error: 'name and platform are required for add' }
          const runnable = args.runnable ? 'true' : 'false'
          const block = '\n[preset.' + Date.now() + ']\n\nname="' + args.name + '"\nplatform="' + args.platform + '"\nrunnable=' + runnable + '\n'
          const existing = await readProjectFile(projectPath, 'export_presets.cfg')
          const next = (existing || '') + block
          try {
            await writeProjectFile(projectPath, 'export_presets.cfg', next)
          } catch (e) {
            return { error: 'write failed: ' + String((e && e.message) || e) }
          }
          return { success: true, preset: args.name, platform: args.platform }
        }
        if (!args.name) return { error: 'name is required for remove' }
        const content = await readProjectFile(projectPath, 'export_presets.cfg')
        if (content === null) return { error: 'No export_presets.cfg found' }
        const esc = args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = new RegExp('\\[preset\\.[^\\]]+\\]\\s*\\n[\\s\\S]*?name="' + esc + '"[\\s\\S]*?(?=\\[preset\\.|$)', 'g')
        const next = content.replace(pattern, '')
        try {
          await writeProjectFile(projectPath, 'export_presets.cfg', next)
        } catch (e) {
          return { error: 'write failed: ' + String((e && e.message) || e) }
        }
        return { success: true, preset: args.name, removed: true }
      },
    }),

    defineTool({
      name: 'godot_create_script',
      description: 'Create a GDScript file from a template (extends, optional class_name, method stubs) or from explicit source.',
      required: ['script_path'],
      properties: {
        script_path: { type: 'string', description: 'Script path relative to project, e.g. scripts/player.gd' },
        extends: { type: 'string', description: 'Base class (default Node)' },
        class_name: { type: 'string', description: 'Optional class_name' },
        methods: { type: 'array', items: { type: 'string' }, description: 'Method stubs to include' },
        source: { type: 'string', description: 'Full source code (overrides template)' },
        project_path: { type: 'string', description: 'Godot project path (default: current session workspace)' },
      },
      async execute(args, exec) {
        const root = await getWorkspaceRoot(exec)
        const projectPath = args.project_path || root
        if (!projectPath) return { error: 'project_path is required (workspace root unavailable)' }
        const scriptPath = String(args.script_path || '')
        if (!/\.gd$/i.test(scriptPath)) return { error: 'script_path must end with .gd' }
        let source = args.source
        if (!source) {
          const ext = args.extends || 'Node'
          const lines = ['extends ' + ext, '']
          if (args.class_name) lines.splice(1, 0, 'class_name ' + args.class_name)
          if (Array.isArray(args.methods)) {
            const overrides = {
              '_ready': 'func _ready() -> void:',
              '_process': 'func _process(delta: float) -> void:',
              '_physics_process': 'func _physics_process(delta: float) -> void:',
              '_input': 'func _input(event: InputEvent) -> void:',
              '_unhandled_input': 'func _unhandled_input(event: InputEvent) -> void:',
              '_enter_tree': 'func _enter_tree() -> void:',
              '_exit_tree': 'func _exit_tree() -> void:',
            }
            for (const m of args.methods) { lines.push('', overrides[m] || ('func ' + m + '():'), '\tpass') }
          }
          source = lines.join('\n') + '\n'
        }
        const slash = scriptPath.lastIndexOf('/')
        const dir = slash > 0 ? projectPath + '/' + scriptPath.slice(0, slash) : projectPath
        await ensureDir(dir)
        try {
          await writeProjectFile(projectPath, scriptPath, source)
        } catch (e) {
          return { error: 'write failed: ' + String((e && e.message) || e) }
        }
        return { success: true, script_path: scriptPath }
      },
    }),

    defineTool({
      name: 'godot_create_project',
      description: 'Scaffold a new Godot project: creates the directory and a minimal project.godot (optionally a Godot .NET C# project with .csproj).',
      required: ['project_path', 'project_name'],
      properties: {
        project_path: { type: 'string', description: 'Directory to create the project in (must be writable by this session)' },
        project_name: { type: 'string', description: 'Project name (also used as config/name)' },
        dotnet: { type: 'boolean', description: 'Scaffold a Godot .NET (C#) project' },
        features: { type: 'string', description: 'config/features value override (default PackedStringArray("4.7") or with "C#")' },
      },
      async execute(args, exec) {
        const projectPath = String(args.project_path || '')
        const projectName = String(args.project_name || '')
        if (!projectPath || !projectName) return { error: 'project_path and project_name are required' }
        await getWorkspaceRoot(exec) // prime sessionWorkspace for the fs sandbox policy
        await ensureDir(projectPath)
        const existing = await readProjectFile(projectPath, 'project.godot')
        if (existing !== null) return { error: 'project.godot already exists at ' + projectPath }
        const isDotnet = args.dotnet === true
        const features = args.features || (isDotnet ? 'PackedStringArray("4.7", "C#")' : 'PackedStringArray("4.7")')
        const asm = projectName.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[0-9]/, '_')
        let content = '; Engine configuration file.\n; Generated by godot-bridge.\n\nconfig_version=5\n\n[application]\n\nconfig/name="' + projectName + '"\nconfig/features=' + features + '\n'
        if (isDotnet) content += '\n[dotnet]\n\nproject/assembly_name="' + asm + '"\n'
        try {
          await writeProjectFile(projectPath, 'project.godot', content)
          if (isDotnet) {
            const csproj = '<Project Sdk="Godot.NET.Sdk/4.4.0">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <EnableDynamicLoading>true</EnableDynamicLoading>\n    <Nullable>enable</Nullable>\n    <RootNamespace>' + asm + '</RootNamespace>\n  </PropertyGroup>\n</Project>\n'
            await writeProjectFile(projectPath, asm + '.csproj', csproj)
          }
        } catch (e) {
          return { error: 'write failed: ' + String((e && e.message) || e) }
        }
        return { success: true, project_path: projectPath, project_name: projectName, dotnet: isDotnet }
      },
    }),

    defineTool({
      name: 'godot_export_project',
      description: 'Export the project headlessly: godot --headless --path <project> --export-debug|--export-release <preset> <output>. Requires an export preset (see godot_manage_export_presets).',
      required: ['preset_name', 'output_path'],
      properties: {
        preset_name: { type: 'string', description: 'Export preset name' },
        output_path: { type: 'string', description: 'Output file path' },
        debug: { type: 'boolean', description: 'Use --export-debug (default false → --export-release)' },
        project_path: { type: 'string', description: 'Godot project path (default: current session workspace)' },
        godot_path: { type: 'string', description: 'Godot executable (default: same resolution as godot_run_project)' },
      },
      timeoutMs: 130000,
      async execute(args, exec) {
        const root = await getWorkspaceRoot(exec)
        const projectPath = args.project_path || root
        if (!projectPath) return { error: 'project_path is required (workspace root unavailable)' }
        const gp = args.godot_path || await getGodotPath()
        const flag = args.debug ? '--export-debug' : '--export-release'
        const res = await runGodotHeadless(gp, projectPath, [flag, String(args.preset_name), String(args.output_path)], exec.signal)
        if (res.spawnError) return { error: 'export spawn failed: ' + res.spawnError }
        const failed = res.err.indexOf('ERROR') >= 0 && res.exitCode !== 0
        return {
          success: !failed,
          preset: args.preset_name,
          output: args.output_path,
          exit_code: res.exitCode,
          stdout: res.out,
          stderr: res.err,
        }
      },
    }),
  ]

  // Clean up the Godot child on plugin stop (matches MCP server cleanup).
  ctx.effect(function () {
    return function () {
      if (godot) {
        try { godot.handle.terminate() } catch (e) {}
        godot = null
      }
    }
  })

  for (let i = 0; i < defs.length; i++) {
    const def = defs[i]
    ctx.effect(function () {
      return tools.register(def)
    })
  }
}
