// Tests for the `task_center` tool: the agent-facing half of the board.
//
// The tool is deliberately thin, so what is worth testing is its CONTRACT rather
// than its maths: that the two user-owned authorisation points are actually
// refused instead of being quietly reachable through the model layer, that a
// draft cannot be claimed before the user releases it, that locks arbitrate
// between two different agents, and that a refusal never writes the file.
//
// Two agents are simulated by calling execute() with different `exec.agent`
// objects, which is what really happens: one registered tool serves every agent.
//
// Run by `npm test`.
import { register } from 'node:module'

register('./stubs/hooks.mjs', import.meta.url)

const PROJECT = 'J:\\demo\\mm13d'
let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || detail === undefined ? '' : '  -> ' + detail}`)
}

/** A filesystem with real FsVersion semantics, enough for the board's CAS. */
function createFs() {
  const files = new Map()
  let counter = 0
  const bump = () => 'v' + String(++counter)
  return {
    files,
    async resolve(path) {
      return { targetKey: path }
    },
    async stat(target) {
      const entry = files.get(target.targetKey)
      return entry === undefined ? undefined : { version: entry.version, type: 'file', size: entry.text.length }
    },
    async readText(target) {
      const entry = files.get(target.targetKey)
      if (entry === undefined) throw new Error('ENOENT')
      return entry.text
    },
    async writeText(target, content, expected) {
      const entry = files.get(target.targetKey)
      if (expected !== undefined && expected.kind === 'createIfAbsent' && entry !== undefined) {
        const error = new Error('FS_STALE_VERSION: exists')
        error.code = 'FS_STALE_VERSION'
        throw error
      }
      if (expected !== undefined && expected.kind === 'replaceIfVersion') {
        if (entry === undefined || entry.version !== expected.version) {
          const error = new Error('FS_STALE_VERSION: moved')
          error.code = 'FS_STALE_VERSION'
          throw error
        }
      }
      const version = bump()
      files.set(target.targetKey, { text: content, version: version })
      return { operation: entry === undefined ? 'create' : 'update', version: version, before: null, after: content }
    },
  }
}

const boardText = (fs) => fs.files.get(PROJECT + '\\.agents\\tasks.json').text
const boardOf = (fs) => JSON.parse(boardText(fs))

/** Register the tool against a fake context and hand back the definition. */
async function loadTool(fs, policy) {
  const module = await import('../../plugin/task-center/tool.mjs')
  let definition = null
  const ctx = {
    fs: fs,
    sandboxPolicy: policy === undefined ? { resolve: () => ({ workspaceRoot: PROJECT }) } : policy,
    logger: { warn() {} },
    tools: {
      register(value) {
        definition = value
        return () => {}
      },
    },
  }
  module.registerTaskTool(ctx)
  return definition
}

const ALICE = { id: 'session-aaaaaaaa-1111' }
const BOB = { id: 'session-bbbbbbbb-2222' }
const call = (definition, action, extra, agent) =>
  definition.execute(Object.assign({ action: action }, extra || {}), { agent: agent === undefined ? ALICE : agent })

// ── the declaration ────────────────────────────────────────────────────────
let fs = createFs()
let tool = await loadTool(fs)
check('the tool registers under one name', tool.name === 'task_center', tool.name)
check('the tool declares an output, which ToolDefinition requires', tool.output !== undefined && typeof tool.output.render === 'function')
check('the declaration lists an action enum', Array.isArray(tool.parameters.action.enum))
check('reads are declared parallel-safe', tool.isConcurrencySafe({ action: 'board' }) === true)
check('writes are not declared parallel-safe', tool.isConcurrencySafe({ action: 'create' }) !== true)
check('claiming is not declared parallel-safe', tool.isConcurrencySafe({ action: 'claim' }) !== true)
check('the user-owned actions are visible so they can be refused by name', tool.parameters.action.enum.indexOf('publish') >= 0 && tool.parameters.action.enum.indexOf('complete') >= 0)

// ── the user's authorisation points are closed to the agent ────────────────
let before = fs.files.size
let result = await call(tool, 'publish', { id: 'T-1' })
check('publishing is refused', result.refused === 'publish', JSON.stringify(result))
check('and the refusal says who owns it', /user/.test(result.reason), result.reason)
result = await call(tool, 'complete', { id: 'T-1' })
check('completing is refused', result.refused === 'complete')
result = await call(tool, 'set_status', { id: 'T-1', status: 'done' })
check('a raw status write is refused', result.refused === 'set_status')
result = await call(tool, 'force_unlock', { path: 'a.gd' })
check('forcing another agent off a lock is refused', result.refused === 'force_unlock')
check('none of those refusals wrote anything', fs.files.size === before, String(fs.files.size))

// ── reading, and creating a draft ──────────────────────────────────────────
result = await call(tool, 'board')
check('an absent board reads as not created', result.board === 'not created yet', JSON.stringify(result.board))
check('and reports zero everywhere', result.total === 0 && result.counts.draft === 0)

result = await call(tool, 'create', { title: '   ' })
check('a task without a title is refused', result.code === 'missing-title', JSON.stringify(result))
check('and nothing was written', fs.files.size === 0, String(fs.files.size))

result = await call(tool, 'create', { title: '伤害系统重构', spec: '收敛到 DamageContext', proposalRef: '.agents/notes/proposed/architecture/2026-10-14-task-center.md' })
check('creating returns the new draft', result.created.id === 'T-1' && result.created.status === 'draft', JSON.stringify(result.created))
check('the draft says where it came from', boardOf(fs).tasks[0].proposalRef === '.agents/notes/proposed/architecture/2026-10-14-task-center.md')
check('the draft records the author in history', boardOf(fs).tasks[0].history[0].by === '@aaaaaaaa', boardOf(fs).tasks[0].history[0].by)
check('creating is reported as a draft count', result.drafts === 1)
check('and the result tells the agent who releases it', /user/.test(result.hint), result.hint)

// ── the release gate is real ───────────────────────────────────────────────
result = await call(tool, 'claim', { id: 'T-1' })
check('a draft cannot be claimed', result.code === 'not-released', JSON.stringify(result))
check('the gate explains whose decision it is', /user has not released/.test(result.error), result.error)

// The user releases it in the panel; emulate that with the same model function
// the panel will use, through the same board layer.
const { readBoard, updateBoard } = await import('../../plugin/task-center/board.mjs')
const { publishTask } = await import('../../plugin/task-center/service.mjs')
const released = await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: (board) => publishTask(board, 'T-1', Date.now(), 'user').board })
check('the emulated release succeeded', released.ok === true, JSON.stringify(released))
check('the draft is now queued', boardOf(fs).tasks[0].status === 'queued')

// ── claiming, working, submitting ──────────────────────────────────────────
result = await call(tool, 'claim', { id: 'T-1' })
check('a released task can be claimed', result.task.assignee.name === '@aaaaaaaa', JSON.stringify(result.task && result.task.assignee))
check('claiming sets a lease', typeof result.task.leaseUntil === 'string')
check('claiming reports its event', result.events.join(',') === 'claimed', JSON.stringify(result.events))

result = await call(tool, 'claim', { id: 'T-1' }, BOB)
check('another agent cannot take a live claim', result.code === 'held', JSON.stringify(result))
result = await call(tool, 'start', { id: 'T-1' })
check('the holder can start it', result.task.status === 'in_progress', JSON.stringify(result.task && result.task.status))
result = await call(tool, 'submit', { id: 'T-1', evidence: 'tests/combat_test.gd 全绿' })
check('the holder can submit for review', result.task.status === 'review', JSON.stringify(result.task && result.task.status))
check('and the evidence is stored', boardOf(fs).tasks[0].evidence === 'tests/combat_test.gd 全绿')
result = await call(tool, 'start', { id: 'T-1' })
check('starting a submitted task sends it back for rework', result.task.status === 'in_progress', JSON.stringify(result.task && result.task.status))
check('and the rework is recorded in history', boardOf(fs).tasks[0].history.slice(-1)[0].from === 'review')
result = await call(tool, 'submit', { id: 'T-1', evidence: 'tests/combat_test.gd 全绿' })
check('submitting again returns it to review', result.task.status === 'review')

const probe = await call(tool, 'create', { title: 'rework probe' })
result = await call(tool, 'start', { id: probe.created.id })
check('a draft cannot be started', result.code === 'illegal-transition', JSON.stringify(result))
check('and the refusal lists the legal moves', /allowed: queued, cancelled/.test(result.error), result.error)

result = await call(tool, 'mine')
check('mine lists the tasks the agent holds', result.tasks.length === 1 && result.tasks[0].id === 'T-1', JSON.stringify(result.tasks))
result = await call(tool, 'mine', {}, BOB)
check('and is empty for an agent that holds nothing', result.tasks.length === 0)

result = await call(tool, 'show', { id: 'T-9' })
check('showing an unknown task is a readable error', /No task with id/.test(result.error), result.error)

// ── locks arbitrate between two agents ─────────────────────────────────────
result = await call(tool, 'lock', { path: 'scripts/core/damage.gd', id: 'T-1' })
check('a free file is granted', result.granted === true, JSON.stringify(result))
result = await call(tool, 'lock', { path: 'scripts/core/damage.gd' }, BOB)
check('a held file is refused to the second agent', result.granted === false, JSON.stringify(result))
check('the refusal names the holder', result.holder === '@aaaaaaaa', String(result.holder))
check('the refusal gives a queue position', result.position === 1, String(result.position))
check('the refusal tells the agent not to write', /Do not write it/.test(result.hint), result.hint)

result = await call(tool, 'locks')
check('locks lists the writer', result.files.length === 1 && result.files[0].holder === '@aaaaaaaa', JSON.stringify(result.files))
check('and names the next in line', result.files[0].next === '@bbbbbbbb', String(result.files[0].next))
check('the first agent sees no blocked paths', result.blockedPaths.length === 0, JSON.stringify(result.blockedPaths))
result = await call(tool, 'locks', {}, BOB)
check('the waiting agent sees the file as blocked', result.blockedPaths.join(',') === 'scripts/core/damage.gd', JSON.stringify(result.blockedPaths))
check('and sees itself queued', result.you.waiting.length === 1 && result.you.waiting[0].position === 1)

result = await call(tool, 'unlock', { path: 'scripts/core/damage.gd' }, BOB)
check('a non-holder cannot unlock', result.refused === 'not-holder', JSON.stringify(result))
result = await call(tool, 'unlock', { path: 'scripts/core/damage.gd' })
check('the holder can unlock', result.released === 'scripts/core/damage.gd')
check('and the longest waiter is granted', result.grantedTo === '@bbbbbbbb', String(result.grantedTo))
result = await call(tool, 'locks')
check('the file now belongs to the second agent', result.files[0].holder === '@bbbbbbbb', JSON.stringify(result.files[0]))

result = await call(tool, 'lock', { path: '' })
check('a lock without a path is refused', /path is required/.test(result.error), result.error)

// ── removal is limited to what an agent should be able to remove ───────────
result = await call(tool, 'remove', { id: 'T-1' })
check('a task in review cannot be removed', result.code === 'not-a-draft', JSON.stringify(result))
const mistake = await call(tool, 'create', { title: 'mistake' })
check('a fresh draft is created', mistake.created.status === 'draft', JSON.stringify(mistake.created))
result = await call(tool, 'remove', { id: mistake.created.id })
check('a draft can be removed', result.events.join(',') === 'removed', JSON.stringify(result.events))
check('and it is gone from the board', boardOf(fs).tasks.filter((task) => task.id === mistake.created.id).length === 0)

// ── identity and project resolution degrade instead of throwing ─────────────
tool = await loadTool(fs, { resolve: () => ({}) })
result = await call(tool, 'board')
check('an unresolvable project is a sentence, not a crash', /project directory is unknown/.test(result.error), JSON.stringify(result))

tool = await loadTool(fs, {
  resolve(options) {
    if (options === undefined || options.session === undefined) return {}
    return { workspaceRoot: PROJECT }
  },
})
const withSession = { session: 'session-cccccccc-3333' }
result = await call(tool, 'create', { title: 'via session field' }, withSession)
check('an agent exposing only `session` still resolves the project', result.created !== undefined, JSON.stringify(result))
check('and its label comes from that field', boardOf(fs).tasks.filter((task) => task.title === 'via session field')[0].history[0].by === '@cccccccc', JSON.stringify(boardOf(fs).tasks.slice(-1)))

const anonymous = { id: '!!!' }
result = await call(tool, 'mine', {}, anonymous)
check('an unnameable agent still gets a label', result.tasks !== undefined, JSON.stringify(result))

// ── a refused write never touches the file ─────────────────────────────────
const snapshot = boardText(fs)
result = await call(tool, 'claim', { id: 'T-404' })
check('claiming an unknown task is refused', result.code === 'unknown-task', JSON.stringify(result))
check('and the file is byte-identical afterwards', boardText(fs) === snapshot)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
