// Runner for the plugin's test suites.
//
// Every suite is a standalone script that prints one line per assertion and
// exits non-zero when any of them fails, so the runner only has to discover the
// files, run them in order and aggregate the exit codes. It deliberately keeps
// going after a failing suite: seeing all three results at once is the point of
// having a runner instead of `a && b && c`.
//
// `stdio: 'inherit'` is not a style choice. Under the DSH file sandbox a child
// process cannot open a named pipe, so capturing a child's output through
// `stdio: 'pipe'` fails with EPERM; inheriting the parent's stdio keeps the
// output streaming and touches no pipe. Do not "fix" this into a pipe.
//
// Usage: npm test
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('.', import.meta.url))
const suites = readdirSync(directory)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

if (suites.length === 0) {
  console.error('no *.test.mjs suites found in ' + directory)
  process.exit(1)
}

const results = []
for (const suite of suites) {
  console.log('\n' + '─'.repeat(72) + '\n' + suite + '\n' + '─'.repeat(72))
  const started = Date.now()
  const run = spawnSync(process.execPath, [directory + suite], { stdio: 'inherit' })
  results.push({ suite: suite, ok: run.status === 0, ms: Date.now() - started })
}

console.log('\n' + '─'.repeat(72))
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.suite}  (${result.ms}ms)`)
}
const failed = results.filter((result) => !result.ok)
console.log(`${results.length - failed.length}/${results.length} suites passed`)
process.exit(failed.length === 0 ? 0 : 1)
