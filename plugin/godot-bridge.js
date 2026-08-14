/**
 * godot-bridge — DeepSeek Harness 动态 Cordis 插件（Host 半部）
 * =============================================================
 * DSH ↔ Godot 引擎运行时控制桥：替代 godot-mcp MCP server。
 *
 * 原理：
 *   游戏内 McpInteractionServer autoload（mcp_interaction_server.gd）在
 *   TCP 127.0.0.1:9090 提供换行分隔 JSON 命令接口（与 godot-mcp 相同的协议）。
 *   本插件用 subprocess.spawn 拉一次性 node 桥进程发送命令并取回响应，
 *   把全部游戏命令注册为原生模型工具。
 *
 * 用法：
 *   1) 在 DSH 会话中让 AI 读取本文件，用 cordis_define（idPrefix: gbrg）
 *      把 code.host 定义为这个函数体，再 cordis_run 运行；
 *   2) 或按 install.md 固化为部署级插件（进程重启后不丢失）。
 *
 * 注意：
 *   - 游戏侧 mcp_interaction_server.gd 必须已注册为 autoload（本项目已有），
 *     插件本身不注入、不改动游戏。
 *   - GODOT_PATH 默认读 <workspace>/.omp/mcp.json 的 env.GODOT_PATH，
 *     找不到则用内置 gdvm 4.7.1 真实 exe 路径；务必用真实 exe，别用 shim。
 *   - eval 命令在 debug 模式下遇到编译错误会卡死游戏（开发备忘坑 7），
 *     代码里用 get("属性") 动态访问绕开类型推断。
 */

return {
  name: 'godot-bridge',
  inject: ['subprocess', 'timer'],
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    const timer = ctx.get('timer')
    if (subprocess === undefined || timer === undefined) return

    const PORT = 9090
    const HOST = '127.0.0.1'
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

    async function getWorkspaceRoot() {
      try {
        const policy = ctx.get('sandboxPolicy')
        if (policy && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0) {
          return policy.workspaceRoot
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

    function tool(name, description, parameters, execute, timeoutMs) {
      return harness.defineTool({
        name: name,
        description: description,
        parameters: parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: function (_args, value) {
            return [{ type: 'text', text: JSON.stringify(value) }]
          },
        },
        timeoutMs: timeoutMs || 30000,
        async execute(args, exec) {
          try {
            return await execute(args, exec)
          } catch (e) {
            return { error: String((e && e.message) || e) }
          }
        },
      })
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

    const definitions = [
      tool('godot_ping',
        'Probe whether the running Godot game accepts commands on the in-game interaction server (TCP 127.0.0.1:9090). Returns game_running plus the probe detail. Use before game commands when unsure the game is up.',
        {
          timeout_ms: { type: 'number', description: 'Probe timeout in ms (default 5000)' },
        },
        async function (args, exec) {
          const resp = await runGameCommand('get_performance', {}, args.timeout_ms || 5000, exec.signal)
          return { game_running: !(resp && resp.error), port: PORT, detail: resp }
        }),

      tool('godot_run_project',
        'Launch the Godot project in debug mode (godot -d --path <project>) and wait for the in-game interaction server. The project must register the McpInteractionServer autoload (mcp_interaction_server.gd) - this project already does. Returns process info and game_ready.',
        {
          project_path: { type: 'string', description: 'Path to the Godot project (default: current session workspace)' },
          scene: { type: 'string', description: 'Optional scene to run relative to the project, e.g. scenes/main/main_menu.tscn' },
          godot_path: { type: 'string', description: 'Godot executable. Default: GODOT_PATH from .omp/mcp.json, else the known gdvm 4.7.1 path. Use the REAL exe full path - never the gdvm shim.' },
          debug: { type: 'boolean', description: 'Run with -d (debug mode). Default true.' },
          wait_ms: { type: 'number', description: 'How long to wait for the interaction server before giving up (default 20000)' },
        },
        async function (args, exec) {
          const root = await getWorkspaceRoot()
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
        60000),

      tool('godot_stop_project',
        'Terminate the Godot process started by godot_run_project (tree-scoped kill, like MCP stop_project).',
        {},
        async function (args, exec) {
          if (!godot) return { stopped: false, reason: 'no Godot process was started by this plugin' }
          const pid = godot.handle.pid
          const projectPath = godot.projectPath
          godot.handle.terminate()
          try {
            await godot.handle.waitForExit(exec.signal)
          } catch (e) {}
          godot = null
          return { stopped: true, pid: pid, project_path: projectPath }
        }),

      tool('godot_get_debug_output',
        'Read stdout/stderr collected from the Godot process launched by godot_run_project. Incremental: returns only output new since the previous call.',
        {},
        async function (args, exec) {
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
        }),

      tool('godot_command',
        'Send one command to the running Godot game via its in-game interaction server (McpInteractionServer autoload on TCP 127.0.0.1:9090). The game must be running (godot_run_project, or started manually - the autoload always listens). Returns the game response JSON verbatim. Core commands: get_scene_tree (scene graph), get_ui_elements (visible UI with positions), screenshot (PNG base64), eval (run GDScript, return value), get_property / set_property / call_method / get_node_info (inspect & mutate nodes), click / key_press / key_hold / key_release / mouse_move / scroll (input), play_animation / tween_property, get_performance, pause, change_scene, instantiate_scene, remove_node, connect_signal / emit_signal / await_signal, raycast, spawn_node, serialize_state, and more.',
        {
          command: { type: 'string', required: true, enum: COMMANDS, description: 'Command to execute in the game' },
          params: { type: 'object', additionalProperties: true, description: 'Command parameters as documented for that command (node_path, property, code, x/y, etc.)' },
          timeout_ms: { type: 'number', description: 'Timeout in ms (default 15000; async commands like screenshot/eval/await_signal may need more)' },
        },
        async function (args, exec) {
          return await runGameCommand(args.command, args.params || {}, args.timeout_ms || 15000, exec.signal)
        },
        40000),

      tool('godot_screenshot',
        'Capture the current game viewport as a PNG. Returns { success, width, height, data } where data is the base64-encoded PNG. Save and decode it to view the game state.',
        {},
        async function (args, exec) {
          const resp = await runGameCommand('screenshot', {}, 20000, exec.signal)
          if (resp && resp.success) return resp
          return { error: (resp && resp.error) || 'screenshot failed' }
        },
        40000),
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

    for (let i = 0; i < definitions.length; i++) {
      const def = definitions[i]
      ctx.effect(function () {
        return harness.registerTool(ctx, def)
      })
    }
  },
}
