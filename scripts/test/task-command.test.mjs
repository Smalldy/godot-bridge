// Probe for the `/task` command as the user actually triggers it.
//
// This goes through the module the Loader loads (`plugin/task-center/index.mjs`),
// captures the registered command definition, and invokes its handler — so it
// covers what the previous probe could not: the board digest appended to the
// signal, the failure sentences for a board we must not touch, and the fact that
// no board problem can cost the user their `/task`.
//
// Run by `npm test` (see scripts/test/run.mjs); safe to run directly.
import { register } from 'node:module'

register('./stubs/hooks.mjs', import.meta.url)

const PROJECT = 'J:\\demo\\mm13d'
let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || detail === undefined ? '' : '  -> ' + detail}`)
}

/** Minimal read-only filesystem: resolve / stat / readText. */
function createFs(text) {
  return {
    async resolve(path) {
      return { targetKey: path }
    },
    async stat(target) {
      if (text === undefined) return undefined
      return { version: 'v1', type: 'file', size: text.length }
    },
    async readText() {
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
  }
}

/** Load the row and hand back its registered command definition. */
async function loadCommand(io) {
  const row = await import('../../plugin/task-center/index.mjs')
  check('the row exports apply without an identity export', typeof row.apply === 'function' && row.name === undefined)
  check('the row declares the services it reads the board through', Array.isArray(row.inject) && row.inject.indexOf('fs') >= 0 && row.inject.indexOf('sandboxPolicy') >= 0, JSON.stringify(row.inject))
  let definition = null
  const ctx = {
    ...io,
    logger: { warn() {} },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(deps, callback) {
      if (deps.indexOf('commands') < 0) throw new Error('unexpected inject: ' + deps.join(','))
      callback({
        commands: {
          register(value) {
            definition = value
            return () => {}
          },
        },
      })
      return () => {}
    },
  }
  row.apply(ctx)
  // The row fills its message factory from a dynamic import; give it a turn.
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('the command registers as `task`', definition !== null && definition.name === 'task', definition && definition.name)
  return definition
}

function invocation(extra, agent) {
  return { agent: agent, rawInput: extra, attachments: [], commandId: 'c1' }
}
function collectingAgent(session) {
  const steered = []
  return {
    steered,
    agent: {
      session: session,
      steer(message) {
        steered.push(message)
      },
    },
  }
}
const signalOpening = 'The user considers this discussion settled and authorises creating real tasks now.'
const hasFullSignal = (message) =>
  String(message.content[0].text).indexOf(signalOpening) === 0 &&
  String(message.content[0].text).indexOf('Record on each task which proposal it came from') > 0
const hasDigest = (message) => String(message.content[0].text).indexOf('\n\nBoard (') > 0

// ── a project with no board yet ────────────────────────────────────────────
let definition = await loadCommand({
  fs: createFs(undefined),
  sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
})
let collector = collectingAgent('session-1')
let result = await definition.handler(invocation('', collector.agent))
check('an empty invocation still reports success to the UI', result.kind === 'success', JSON.stringify(result))
check('exactly one message is steered', collector.steered.length === 1, String(collector.steered.length))
let text = collector.steered[0].content[0].text
check('the steered message is a user message', collector.steered[0].source.kind === 'user')
check('the steered message carries the whole signal', hasFullSignal(collector.steered[0]), collector.steered[0].content[0].text)
check('the digest is appended after the signal', hasDigest(collector.steered[0]))
check('an absent board is reported as not created yet', /Board \(\.agents\/tasks\.json\): not created yet/.test(text), text)
check('the extra instruction is appended', text.indexOf('The user adds:') < 0, 'no extra expected')

// ── extra text, and a board with content ───────────────────────────────────
const seeded = JSON.stringify({
  version: 1,
  seq: 20,
  updatedAt: new Date(Date.now() - 3 * 60000).toISOString(),
  tasks: [
    { id: 'T-1', title: 'first', status: 'done' },
    { id: 'T-2', title: 'second', status: 'done' },
    { id: 'T-3', title: 'third', status: 'queued' },
    { id: 'T-4', title: 'fourth', status: 'queued' },
    { id: 'T-5', title: 'fifth', status: 'queued' },
    { id: 'T-6', title: 'sixth', status: 'queued' },
    { id: 'T-7', title: 'seventh', status: 'in_progress' },
    { id: 'T-8', title: 'eighth', status: 'blocked' },
    { id: 'T-9', title: 'ninth', status: 'review' },
  ],
})
definition = await loadCommand({
  fs: createFs(seeded),
  sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
})
collector = collectingAgent('session-1')
await definition.handler(invocation('先只拆敌人AI相关的', collector.agent))
text = collector.steered[0].content[0].text
check('the extra instruction reaches the agent', /The user adds: 先只拆敌人AI相关的/.test(text), text)
check('counts come from the board', /9 tasks — queued 4 · claimed\/in progress 1 · blocked 1 · review 1 · done 2/.test(text), text)
check('the board age is summarised', /updated 3m ago/.test(text), text)
check('the queue head is bounded to three and says how many remain', /Queue head: T-3 third; T-4 fourth; T-5 fifth \(\+1 more\)/.test(text), text)

// ── a board we must not touch ──────────────────────────────────────────────
definition = await loadCommand({
  fs: createFs('{ not json'),
  sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
})
collector = collectingAgent('session-1')
result = await definition.handler(invocation('', collector.agent))
check('a broken board does not fail the command', result.kind === 'success', JSON.stringify(result))
text = collector.steered[0].content[0].text
check('a broken board is reported with its code', /Board \(\.agents\/tasks\.json\): unparseable/.test(text), text)
check('and the agent is told not to overwrite it', /Do NOT overwrite that file/.test(text), text)
check('the signal still arrives intact', hasFullSignal(collector.steered[0]))

// ── an unresolvable project directory ──────────────────────────────────────
definition = await loadCommand({
  fs: createFs(seeded),
  sandboxPolicy: {
    resolve() {
      throw new Error('no session')
    },
  },
})
collector = collectingAgent('session-1')
result = await definition.handler(invocation('', collector.agent))
check('a missing workspace does not fail the command', result.kind === 'success', JSON.stringify(result))
check(
  'a missing workspace is reported as unknown',
  /the project directory is unknown/.test(collector.steered[0].content[0].text),
  collector.steered[0].content[0].text,
)

// ── a filesystem that throws ───────────────────────────────────────────────
definition = await loadCommand({
  fs: {
    async resolve() {
      throw new Error('ESANDBOX: path outside the workspace')
    },
  },
  sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
})
collector = collectingAgent('session-1')
result = await definition.handler(invocation('', collector.agent))
check('a filesystem error does not fail the command', result.kind === 'success', JSON.stringify(result))
check(
  'a filesystem error becomes a sentence in the digest',
  /Board \(\.agents\/tasks\.json\): unreadable/.test(collector.steered[0].content[0].text),
  collector.steered[0].content[0].text,
)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
