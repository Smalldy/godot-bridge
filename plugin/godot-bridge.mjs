/**
 * godot-bridge — DSH ↔ Godot 运行时控制桥（部署级插件模块）
 * ===========================================================
 * 这是给 cordis 组合（agent preset）用的 ESM 模块形态：
 *   - 命名导出 name / inject / apply（cordis Loader 的 unwrapExports 支持）
 *   - 零 import：预设位于 ~/.dsh 下，Node 向上解析不到 harness 的 node_modules，
 *     所以不 import 任何 @deepseek-ai/* 包；工具定义用手写 JSON Schema 直接
 *     ctx.tools.register（register 只校验 output.render / output.schema / timeoutMs）。
 *
 * 组合行（agent.cordis.yml）：
 *   - id: tool-godot-bridge
 *     name: './plugins/godot-bridge.mjs'
 *
 * 与动态插件版（tools/godot-bridge/godot-bridge.js，code.host 形态）逻辑一致，
 * 只是注册 API 从 harness.defineTool/registerTool 换成 ctx.tools.register。
 *
 * 注意：GODOT_PATH 默认读 <workspace>/.omp/mcp.json 的 env.GODOT_PATH，
 * 找不到用内置 gdvm 4.7.1 真实 exe 路径；务必用真实 exe，别用 shim。
 */

export const name = 'godot-bridge'

export const inject = ['subprocess', 'timer', 'tools']

export function apply(ctx) {
  const subprocess = ctx.get('subprocess')
  const timer = ctx.get('timer')
  const tools = ctx.get('tools')
  if (subprocess === undefined || timer === undefined || tools === undefined) return

  const PORT = 9090
  const FALLBACK_GODOT = 'C:/Users/74368/.gdvm/installs/registry.gdvm.io-7999f4302078c203/default/4.7.1-stable/Godot_v4.7.1-stable_win64.exe'

  let nodePath = null
  let godotPath = null
  let godot = null // { handle, outOffset, errOffset, projectPath, scene }

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
      const policy = ctx.get('sandboxPolicy')
      if (!policy) return null
      const resolved = exec && exec.agent
        ? policy.resolve({ session: exec.agent.session })
        : policy.resolve()
      if (resolved && typeof resolved.workspaceRoot === 'string' && resolved.workspaceRoot.length > 0) {
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
      const fs = ctx.get('fs')
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

  // One-shot node bridge: connect to the in-game TCP server, send one
  // newline-delimited JSON command, print the first complete response line.
  // NOTE: with `node -e <script> <cmd> <paramsJson>`, the extra args land at
  // process.argv[1] and process.argv[2] (argv[0] is node itself).
  const BRIDGE = [
    "var NL=String.fromCharCode(10);",
    "var net=require('net');",
    "var cmd=process.argv[1]||'';",
    "var params={};",
    "try{params=JSON.parse(process.argv[2]||'{}');}catch(e){}",
    "var sock=net.connect(9090,'127.0.0.1');",
    "var buf='',done=false;",
    "function fin(obj){if(done){return;}done=true;clearTimeout(t);try{sock.destroy();}catch(e){}process.stdout.write(JSON.stringify(obj));}",
    "var t=setTimeout(function(){fin({error:'bridge timeout'});},20000);",
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
        argv: [node, '-e', BRIDGE, String(command), JSON.stringify(params || {})],
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

  async function resolveScriptFile(name, explicit, projectPath, exec) {
    if (explicit) return explicit
    try {
      if (typeof import.meta !== 'undefined' && import.meta.url) {
        const u = new URL('./' + name, import.meta.url)
        return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1')
      }
    } catch (e) {}
    const fs = ctx.get('fs')
    const candidates = []
    if (projectPath) {
      candidates.push(projectPath + '/tools/godot-bridge/' + name)
      candidates.push(projectPath + '/../godot-mcp/src/scripts/' + name)
    }
    const root = await getWorkspaceRoot(exec)
    if (root) {
      candidates.push(root + '/tools/godot-bridge/' + name)
      candidates.push(root + '/../godot-mcp/src/scripts/' + name)
    }
    for (const c of candidates) {
      try {
        const t = await fs.resolve(c, { cwd: projectPath || root || '.' })
        const i = await fs.stat(t)
        if (i) return c
      } catch (e) {}
    }
    return candidates.length > 0 ? candidates[0] : name
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

  // Hand-built ToolDefinition (JSON-schema parameters) registered via
  // ctx.tools.register — no defineTool import needed in this module.
  function defineTool(opt) {
    const parameters = { type: 'object', properties: opt.properties, additionalProperties: false }
    if (opt.required && opt.required.length > 0) parameters.required = opt.required
    return {
      name: opt.name,
      description: opt.description,
      parameters: parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: function (_args, value) {
          return [{ type: 'text', text: JSON.stringify(value) }]
        },
      },
      timeoutMs: opt.timeoutMs || 30000,
      async execute(args, exec) {
        try {
          return await opt.execute(args, exec)
        } catch (e) {
          return { error: String((e && e.message) || e) }
        }
      },
    }
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
        return { game_running: !(resp && resp.error), port: PORT, detail: resp }
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
        const ops = await resolveScriptFile('godot_operations.gd', args.ops_script, projectPath, exec)
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
        const vs = await resolveScriptFile('validate_script.gd', args.validate_script, projectPath, exec)
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
