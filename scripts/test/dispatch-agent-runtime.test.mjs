import { createRig, createTask } from './support/fixtures.mjs'

const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: condition === true })
  console.log((condition === true ? 'PASS' : 'FAIL') + '  ' + name + (condition === true || detail === undefined ? '' : '  -> ' + String(detail)))
}

const spawned = []
const stageSpawns = []
const taskAgents = {
  available: true,
  root: { id: 'session-lead', name: 'lead' },
  rootId: 'session-lead',
  runtime: {
    root: { id: 'session-lead', name: 'lead' },
    async list() { return spawned.concat(stageSpawns).map((entry) => ({ id: entry.agent.agentId, name: entry.agent.name, role: entry.agent.role, status: 'inactive' })) },
  },
  async startWorker(task, prompt) {
    const agent = { agentId: 'agent-worker', name: 'worker-' + String(task.id).toLowerCase(), role: 'worker', handle: { dispose: async () => {} } }
    spawned.push({ taskId: task.id, prompt, agent })
    return agent
  },
  async startReviewer(task, prompt) {
    const agent = { agentId: 'agent-reviewer', name: 'reviewer-' + String(task.id).toLowerCase(), role: 'reviewer', handle: { dispose: async () => {} } }
    stageSpawns.push({ kind: 'reviewer', taskId: task.id, prompt, agent })
    return agent
  },
  async startTester(task, prompt) {
    const agent = { agentId: 'agent-tester', name: 'tester-' + String(task.id).toLowerCase(), role: 'tester', handle: { dispose: async () => {} } }
    stageSpawns.push({ kind: 'tester', taskId: task.id, prompt, agent })
    return agent
  },
  async send() { return 'message' },
  async release() { return true },
}

const rig = createRig({
  taskAgents,
  roles: {},
  merger: {
    async createCandidate(task, projectPath) {
      return { ok: true, path: projectPath + '\\.worktrees\\test-candidate', base: 'base-sha', head: 'candidate-sha', target: 'main' }
    },
  },
})
const created = await createTask(rig, { title: 'agent runtime smoke', writeFiles: [] })
let started = await rig.action('start', {})
check('dispatch starts with the new agent runtime', started.ok === true && started.dispatch.state === 'running', JSON.stringify(started).slice(0, 600))
await rig.settle()
let read = await rig.state.read(rig.project)
let task = read.board.tasks.filter((entry) => entry.id === created.id)[0]
check('the ready task is claimed by a spawned worker', task !== undefined && task.status === 'running', task && JSON.stringify({ status: task.status, assignee: task.assignee }))
check('assignee.session is the Agent Session id', task !== undefined && task.assignee !== null && task.assignee.session === 'agent-worker', task && JSON.stringify(task.assignee))
check('the brief is delivered as the initial spawn prompt', spawned.length === 1 && spawned[0].prompt.indexOf(created.id) >= 0, JSON.stringify(spawned.map((entry) => entry.taskId)))
check('the legacy pickTarget path is not the one that assigned it', task !== undefined && task.dispatch !== null && task.dispatch.via === 'spawn', task && JSON.stringify(task.dispatch))

const submitted = await rig.action('submit', { id: created.id, evidence: 'implemented' })
check('submit spawns a reviewer child', submitted.ok === true && stageSpawns.some((entry) => entry.kind === 'reviewer' && entry.taskId === created.id), JSON.stringify(submitted).slice(0, 800))
read = await rig.state.read(rig.project)
task = read.board.tasks.filter((entry) => entry.id === created.id)[0]
check('submit moves the card into review', task !== undefined && task.status === 'reviewing', task && task.status)
check('the reviewer delivery is recorded by id', task !== undefined && task.review !== null && task.review !== undefined && task.review.deliveredTo !== null && task.review.deliveredTo.id === 'agent-reviewer', task && JSON.stringify(task.review))
const treeSnap = await rig.api.snapshot(rig.project, { sessionId: 'session-lead' })
check('the snapshot exposes the root Agent and live children', treeSnap.agentTree !== null && treeSnap.agentTree.root.id === 'session-lead' && treeSnap.agentTree.members.some((member) => member.id === 'agent-worker') && treeSnap.agentTree.members.some((member) => member.id === 'agent-reviewer'), JSON.stringify(treeSnap.agentTree))

const approved = await rig.action('approveReview', { id: created.id, checked: [{ criterion: 'the card moves through the stage', method: 'read the board result', result: 'pass' }] })
check('approveReview starts a tester child', approved.ok === true && stageSpawns.some((entry) => entry.kind === 'tester' && entry.taskId === created.id), JSON.stringify(approved).slice(0, 900))
read = await rig.state.read(rig.project)
task = read.board.tasks.filter((entry) => entry.id === created.id)[0]
check('the card is testing', task !== undefined && task.status === 'testing', task && task.status)
check('the tester delivery is recorded by id', task !== undefined && task.test !== null && task.test !== undefined && task.test.deliveredTo !== null && task.test.deliveredTo.id === 'agent-tester', task && JSON.stringify(task.test))

// T-183: a card that leaves its active phases must not keep presenting its
// reviewer/tester/worker as live executors of the card in the snapshot.
const blocked = await rig.action('block', { id: created.id, note: 'T-183 regression' })
check('blocking a testing card succeeds', blocked.ok === true, JSON.stringify(blocked).slice(0, 600))
const endedSnap = await rig.api.snapshot(rig.project, { sessionId: 'session-lead' })
const endedMembers = endedSnap.agentTree === null ? [] : endedSnap.agentTree.members
check(
  'a blocked card leaves no running stage child in the snapshot',
  endedSnap.agentTree !== null && endedMembers.every((member) => member.status !== 'running') && endedMembers.filter((member) => member.taskId === created.id).length === 0,
  JSON.stringify(endedMembers),
)
check(
  'finished-stage children are not shown as live executors of the ended card',
  endedMembers.length === 0,
  JSON.stringify(endedMembers),
)
rig.scheduler.dispose()

const failed = checks.filter((entry) => !entry.ok)
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
