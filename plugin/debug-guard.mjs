/**
 * Pure helpers for the Godot debugger guards (issue #13).
 *
 * Kept dependency-free so unit tests can import them without the DSH tool
 * runtime. godot-bridge.mjs uses them for argv construction, debugger-trap
 * detection, debugger trace extraction, ping classification, eval timeouts and
 * the user:// log-size warning.
 */

/** Build the godot_run_project argv. -d is opt-in (diagnostic mode) only. */
export function buildLaunchArgv(godotPath, projectPath, opts) {
  const options = opts === undefined || opts === null ? {} : opts
  const argv = [String(godotPath)]
  if (options.debug === true) argv.push('-d')
  argv.push('--path', String(projectPath))
  if (options.scene) argv.push(String(options.scene))
  return argv
}

/** True when captured stdout shows the interactive local debugger. */
export function detectDebuggerTrap(text) {
  const value = typeof text === 'string' ? text : ''
  return /(^|\n)\s*debug>\s*$/m.test(value) || /Debugger Break, Reason:/.test(value)
}

/**
 * Extract the debugger trace: the most recent "Debugger Break, Reason: ..."
 * line is the title, the immediately following "*Frame N - ..." lines are
 * frames (a <file>:<line> location is parsed out), and the raw tail (<=4KB) is
 * kept for reference.
 */
export function parseDebuggerTrace(text) {
  const value = typeof text === 'string' ? text : ''
  const lines = value.split(/\r?\n/)
  let titleIndex = -1
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/Debugger Break, Reason:/.test(lines[index])) {
      titleIndex = index
      break
    }
  }
  const frames = []
  if (titleIndex >= 0) {
    for (let index = titleIndex + 1; index < lines.length; index++) {
      const line = lines[index]
      if (!/^\s*\*Frame \d+/.test(line)) {
        if (frames.length > 0) break
        continue
      }
      const location = /([A-Za-z]:[\\/][^\s()]+|res:\/\/[^\s():]+|[^\s():]+\.gd):(\d+)/.exec(line)
      frames.push({
        text: line.trim(),
        frame: Number((/\*Frame (\d+)/.exec(line) || [])[1]),
        file: location === null ? null : location[1],
        line: location === null ? null : Number(location[2]),
      })
    }
  }
  return {
    title: titleIndex >= 0 ? lines[titleIndex].trim() : null,
    frames: frames,
    tail: value.slice(-4096),
  }
}

/** The advisory returned when godot_run_project starts with debug:true. */
export function debuggerNote(debugEnabled) {
  if (debugEnabled !== true) return null
  return {
    warning: 'This instance runs with the local debugger (-d): eval is disabled, and a script error ends this run with a debuggerTrace.',
    next: 'Use godot_run_headless --script to run code; restart without debug:true for interactive eval.',
  }
}

/**
 * Classify a godot_ping probe. A connection that is accepted but never answers
 * is a LIVE but unresponsive instance, not "no game".
 */
export function classifyProbe(response) {
  if (response !== null && response !== undefined && !response.error) return { game_running: true, responsive: true, diagnosis: null }
  const detail = response !== null && response !== undefined && typeof response.error === 'string' ? response.error : ''
  if (/timeout|timed out|unresponsive|no response/i.test(detail)) {
    return {
      game_running: true,
      responsive: false,
      diagnosis: 'unresponsive',
      note: 'The port accepted the connection but the instance did not answer in time; it may be stuck in the debugger or busy. Check godot_get_debug_output, then godot_stop_project and restart without debug:true.',
    }
  }
  return { game_running: false, responsive: false, diagnosis: null }
}

/** The eval timeout answer: a stuck instance is reported, never queued silently. */
export function evalTimeoutResult(command, timeoutMs) {
  const isEval = String(command) === 'eval'
  return {
    error: 'bridge timeout',
    diagnosis: 'unresponsive',
    command: String(command),
    timeout_ms: Number(timeoutMs) || null,
    next: isEval
      ? 'The instance may be stuck (a local-debugger trap is the usual cause). Check godot_get_debug_output; if it shows debug> or Debugger Break, godot_stop_project and restart without debug:true, or run the code with godot_run_headless --script.'
      : 'The instance did not answer; check godot_get_debug_output and restart it if needed.',
  }
}

/** Warn when the user:// log grew past the threshold; never deletes anything. */
export function logSizeWarning(bytes, threshold) {
  const size = Number(bytes)
  const limit = Number.isFinite(threshold) ? threshold : 256 * 1024 * 1024
  if (!Number.isFinite(size) || size < limit) return null
  return 'user://logs/godot.log is ' + Math.round(size / (1024 * 1024)) + ' MB; consider disabling debug/file_logging in project.godot and clearing the log by hand (the plugin never deletes user files).'
}

/**
 * How to leave the interactive debugger safely. NEVER send "continue": a syntax
 * error breaks again immediately (the same error), only "quit" really exits.
 */
export function debuggerRecoveryPlan() {
  return { action: 'quit', input: 'quit\n', waitMs: 3000, forbidden: ['continue'] }
}
