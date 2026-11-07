import assert from 'node:assert/strict'
import { createGitProcessChecker } from '../../plugin/task-center/process-check.mjs'

const winRunning = createGitProcessChecker({
  platform: 'win32',
  run: async () => ({ code: 0, stdout: '"git.exe","1234","Console","1","10,000 K"\r\n', stderr: '' }),
})
assert.equal((await winRunning.check()).running, true)

const winIdle = createGitProcessChecker({
  platform: 'win32',
  run: async () => ({ code: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\r\n', stderr: '' }),
})
assert.equal((await winIdle.check()).running, false)

const winError = createGitProcessChecker({
  platform: 'win32',
  run: async () => ({ code: 1, stdout: '', stderr: 'denied' }),
})
assert.equal((await winError.check()).running, null)

const posixRunning = createGitProcessChecker({
  platform: 'linux',
  run: async () => ({ code: 0, stdout: '/usr/bin/git\n/usr/bin/node\n', stderr: '' }),
})
assert.equal((await posixRunning.check()).running, true)

const posixIdle = createGitProcessChecker({
  platform: 'linux',
  run: async () => ({ code: 0, stdout: '/usr/bin/node\n', stderr: '' }),
})
assert.equal((await posixIdle.check()).running, false)

console.log('PASS  process checker detects git on Windows and POSIX')
console.log('PASS  a failed probe is unknown, never a false "no process"')
