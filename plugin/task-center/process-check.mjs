/**
 * Is a git process running?
 *
 * The stale-lock reconciler only renames an index.lock when an injected checker
 * says no git process is alive. This module is that checker: a read-only
 * tasklist/ps probe with an injectable runner, so tests never start a process
 * and a host that cannot inspect processes simply reports unknown.
 */
import { execFile } from 'node:child_process'

function defaultRun(command, args) {
  return new Promise((resolveRun) => {
    execFile(command, args, { windowsHide: true, encoding: 'utf8', timeout: 5000 }, (error, stdout, stderr) => {
      const code = error === null || error === undefined ? 0 : typeof error.code === 'number' ? error.code : 1
      resolveRun({ code: code, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : String(stderr || '') })
    })
  })
}

export function createGitProcessChecker(options) {
  const opts = options === undefined || options === null ? {} : options
  const run = typeof opts.run === 'function' ? opts.run : defaultRun
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform

  async function check() {
    try {
      const result = platform === 'win32'
        ? await run('tasklist', ['/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH'])
        : await run('ps', ['-A', '-o', 'comm='])
      if (result === null || result === undefined || result.code !== 0) {
        return { running: null, detail: 'the process probe failed' + (result !== null && result !== undefined && result.stderr ? ': ' + String(result.stderr).trim() : '') }
      }
      const text = String(result.stdout === undefined || result.stdout === null ? '' : result.stdout)
      if (platform === 'win32') {
        const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '' && !/^INFO:/i.test(line.trim()))
        const running = lines.some((line) => /git(\.exe)?/i.test(line))
        return { running: running, detail: running ? 'git.exe is running' : 'no git.exe process' }
      }
      const running = text.split(/\r?\n/).some((line) => {
        const name = line.trim().split('/').pop()
        return name === 'git'
      })
      return { running: running, detail: running ? 'git is running' : 'no git process' }
    } catch (error) {
      return { running: null, detail: String((error && error.message) || error) }
    }
  }

  return { check: check, platform: platform }
}

export function createDefaultGitProcessChecker() {
  return createGitProcessChecker({})
}
