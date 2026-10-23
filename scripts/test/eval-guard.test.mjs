// Self-contained regression test for issue #13 (eval deadlock under the local
// debugger). No task-center harness, no DSH runtime: run with
//   node --test scripts/test/eval-guard.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildLaunchArgv,
  classifyDebuggerExit,
  classifyProbe,
  debuggerNote,
  debuggerRecoveryPlan,
  detectDebuggerTrap,
  evalTimeoutResult,
  logSizeWarning,
  parseDebuggerTrace,
} from '../../plugin/debug-guard.mjs'

const BRIDGE = readFileSync(fileURLToPath(new URL('../../plugin/godot-bridge.mjs', import.meta.url)), 'utf8')
const SERVER = readFileSync(fileURLToPath(new URL('../../plugin/mcp_interaction_server.gd', import.meta.url)), 'utf8')

test('the default launch has no local debugger; diagnostic mode adds -d', () => {
  const plain = buildLaunchArgv('C:/godot/godot.exe', 'C:/proj', {})
  assert.equal(plain.includes('-d'), false, JSON.stringify(plain))
  assert.equal(plain[0], 'C:/godot/godot.exe')
  assert.equal(plain[plain.indexOf('--path') + 1], 'C:/proj')
  const diagnostic = buildLaunchArgv('C:/godot/godot.exe', 'C:/proj', { debug: true })
  assert.equal(diagnostic.includes('-d'), true, JSON.stringify(diagnostic))
  const scene = buildLaunchArgv('C:/godot/godot.exe', 'C:/proj', { debug: false, scene: 'main.tscn' })
  assert.equal(scene.includes('-d'), false)
  assert.equal(scene.includes('main.tscn'), true)
})

test('diagnostic mode returns the eval-disabled warning and a next step', () => {
  const note = debuggerNote(true)
  assert.ok(note)
  assert.match(note.warning, /eval is disabled/)
  assert.match(note.next, /godot_run_headless --script/)
  assert.equal(debuggerNote(false), null)
  assert.match(BRIDGE, /DIAGNOSTIC mode/)
  assert.match(BRIDGE, /eval is DISABLED/)
  assert.match(BRIDGE, /debuggerTrace/)
  assert.match(BRIDGE, /NO local debugger by default/)
  assert.match(BRIDGE, /Default false/)
})

test('the always-on rule explains eval is unavailable in diagnostic mode', () => {
  assert.match(BRIDGE, /godot-bridge:debug-eval/)
  assert.match(BRIDGE, /eval 不可用/)
  assert.match(BRIDGE, /godot_run_headless --script/)
  assert.match(BRIDGE, /debuggerTrace/)
})

test('a debug> prompt or Debugger Break is a trap; ordinary output is not', () => {
  assert.equal(detectDebuggerTrap('Godot Engine\n debug> '), true)
  assert.equal(detectDebuggerTrap('Debugger Break, Reason: Parser Error\n'), true)
  assert.equal(detectDebuggerTrap('McpInteractionServer: Listening on 127.0.0.1:9090'), false)
})

test('debuggerTrace keeps the break reason, frames with file:line, and the raw tail', () => {
  const sample = [
    'SCRIPT ERROR: Parse Error',
    'Debugger Break, Reason: Parser Error',
    '*Frame 0 - res://scripts/player.gd:42 in function _ready',
    '*Frame 1 - res://scripts/main.gd:7 in function _process',
    'debug> ',
  ].join('\n')
  const trace = parseDebuggerTrace(sample)
  assert.ok(trace.title)
  assert.match(trace.title, /Parser Error/)
  assert.equal(trace.frames.length, 2)
  assert.equal(trace.frames[0].file, 'res://scripts/player.gd')
  assert.equal(trace.frames[0].line, 42)
  assert.equal(trace.frames[1].line, 7)
  assert.ok(trace.tail.includes('Parser Error'))
  assert.ok(trace.tail.length <= 4096)
})

test('the recovery input is exactly quit (never continue), with a 3s fallback', () => {
  const plan = debuggerRecoveryPlan()
  assert.equal(plan.input, 'quit\n')
  assert.equal(plan.input.includes('continue'), false)
  assert.equal(plan.waitMs, 3000)
  assert.match(BRIDGE, /writeStdinTo\(handle, plan\.input\)/)
  assert.match(BRIDGE, /stdin: debugMode \? 'pipe' : 'ignore'/)
  assert.match(BRIDGE, /handle\.terminate\(\)/)
})

test('the debugger exit is classified by exit code, not by "it exited fast"', () => {
  const clean = classifyDebuggerExit({ exited: true, exitCode: 0, killed: false })
  assert.equal(clean.diagnosis, 'debugger-quit')
  assert.equal(clean.crash, false)
  assert.equal(clean.killed, false)
  // Godot 4.7.2 win64: writing quit under the local debugger exits with an
  // ACCESS_VIOLATION (3221225477 = 0xC0000005), not a clean exit.
  const crashed = classifyDebuggerExit({ exited: true, exitCode: 3221225477, killed: false })
  assert.equal(crashed.diagnosis, 'debugger-trap')
  assert.equal(crashed.crash, true)
  assert.equal(crashed.exitCode, 3221225477)
  const killed = classifyDebuggerExit({ exited: false, exitCode: null, killed: true })
  assert.equal(killed.diagnosis, 'debugger-trap')
  assert.equal(killed.killed, true)
  assert.equal(killed.crash, false)
  assert.match(BRIDGE, /classifyDebuggerExit\(\{ exited: debuggerWatch\.exited/)
  assert.match(BRIDGE, /exitCodeOf\(handle\)/)
  assert.match(BRIDGE, /crash: classified\.crash/)
})

test('the docs record the real exit code and the EOF reproduction baseline', () => {
  const docs = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8') + readFileSync(fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url)), 'utf8')
  assert.match(docs, /0xC0000005|3221225477|ACCESS_VIOLATION/)
  assert.match(docs, /12089|12,089/)
  assert.match(docs, /1\.78 MB|1,78 MB/)
})

test('a connection that never answers is running but unresponsive', () => {
  assert.deepEqual(classifyProbe({ success: true }), { game_running: true, responsive: true, diagnosis: null })
  const stuck = classifyProbe({ error: 'bridge timeout' })
  assert.equal(stuck.game_running, true)
  assert.equal(stuck.responsive, false)
  assert.equal(stuck.diagnosis, 'unresponsive')
  const dead = classifyProbe({ error: 'ECONNREFUSED' })
  assert.equal(dead.game_running, false)
  assert.equal(dead.responsive, false)
  assert.match(BRIDGE, /responsive: classified\.responsive/)
})

test('an eval timeout is bridge timeout / unresponsive with a next step', () => {
  const timeout = evalTimeoutResult('eval', 15000)
  assert.equal(timeout.error, 'bridge timeout')
  assert.equal(timeout.diagnosis, 'unresponsive')
  assert.match(timeout.next, /godot_stop_project/)
  assert.match(BRIDGE, /evalTimeoutResult\(command, timeoutMs\)/)
})

test('the log-size warning never deletes user files', () => {
  assert.equal(logSizeWarning(1024, 256 * 1024 * 1024), null)
  const warning = logSizeWarning(300 * 1024 * 1024, 256 * 1024 * 1024)
  assert.ok(typeof warning === 'string')
  assert.match(warning, /file_logging/)
})

test('the server exposes a pure debugger predicate and guards every reload()', () => {
  assert.match(SERVER, /static func is_local_debugger\(args\) -> bool:/)
  assert.match(SERVER, /String\(arg\) == "-d" or String\(arg\) == "--debug"/)
  assert.match(SERVER, /_local_debugger = is_local_debugger\(OS\.get_cmdline_args\(\)\)/)
  assert.match(SERVER, /EVAL_DEBUGGER_REFUSAL/)
  assert.match(SERVER, /"diagnosis": "debugger-trap"/)
  assert.match(SERVER, /godot_run_headless --script/)
  const guards = (SERVER.match(/if _local_debugger:/g) || []).length
  const reloads = (SERVER.match(/\.reload\(\)/g) || []).length
  assert.ok(guards >= reloads, JSON.stringify({ guards: guards, reloads: reloads }))
})

test('eval refusals and debugger results carry a next step; SCRIPT ERROR carries a hint', () => {
  assert.match(BRIDGE, /resp\.diagnosis === 'debugger-trap'/)
  assert.match(BRIDGE, /resp\.next = 'eval is disabled/)
  assert.match(BRIDGE, /classifyDebuggerExit\(\{ exited: debuggerWatch\.exited/)
  assert.match(BRIDGE, /debuggerTrace: debuggerWatch\.trace/)
  assert.match(BRIDGE, /scriptErrorHint/)
  assert.match(BRIDGE, /restart with debug:true/)
})
