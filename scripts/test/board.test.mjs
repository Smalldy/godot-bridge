// Board storage tests: schema, migration, CAS and the limits that keep a
// hand-edited board from corrupting the model.

import { join } from 'node:path'
import { readBoard, updateBoard, emptyBoard, boardPath, MAX_HISTORY, readRoleConfig, writeRoleConfig, rolesPath } from '../../plugin/task-center/board.mjs'
import {
  defaultRoleConfig,
  normaliseDispatch,
  normaliseRoleConfig,
  normaliseWorktree,
  validateRoleBinding,
  validateRoleProfile,
} from '../../plugin/task-center/schema.mjs'
import { createFakeFs, seedBoard, boardText, PROJECT } from './support/fixtures.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}
const read = (fs, project) => readBoard({ fs }, { projectPath: project === undefined ? PROJECT : project })
const isFailure = (result, code) => result.ok === false && (code === undefined || result.code === code)

// path + shape
check('board lives under .agents/tasks.json', boardPath(PROJECT) === join(PROJECT, '.agents', 'tasks.json'), boardPath(PROJECT))
const empty = emptyBoard(1000)
check('empty board is version 2', empty.version === 2)
check('empty board starts paused', empty.dispatch.state === 'paused')
check('empty board has a sequence', empty.seq === 1)

// sequential writes and id allocation
{
  const fs = createFakeFs()
  const first = await read(fs)
  check('an absent board reads as empty', first.ok === true && first.existed === false)
  seedBoard(fs, PROJECT, JSON.stringify({ version: 2, seq: 9, tasks: [{ id: 'T-8', title: 'hand written' }] }))
  const seeded = await read(fs)
  check('hand-written seq below the highest id is raised', seeded.ok === true && seeded.board.seq === 9, String(seeded.board && seeded.board.seq))
  const written = await updateBoard(
    { fs },
    {
      projectPath: PROJECT,
      mutate: (board) => ({ ...board, seq: board.seq + 1, tasks: board.tasks.concat([{ id: 'T-' + board.seq, title: 'next' }]) }),
    },
  )
  check('update writes through the CAS', written.ok === true)
  check('both tasks survive', written.board.tasks.map((task) => task.id).join(',') === 'T-8,T-9', written.board.tasks.map((task) => task.id).join(','))
}

// duplicate and malformed ids are fatal, never guessed
{
  const fs = createFakeFs()
  seedBoard(fs, PROJECT, JSON.stringify({ version: 2, seq: 2, tasks: [{ id: 'T-1' }, { id: 'T-1' }] }))
  const result = await read(fs)
  check('duplicate ids are refused', isFailure(result, 'duplicate-task'), JSON.stringify(result))
  const fs2 = createFakeFs()
  seedBoard(fs2, PROJECT, JSON.stringify({ version: 2, seq: 2, tasks: [null] }))
  check('a non-object task is refused', isFailure(await read(fs2), 'invalid-task'))
}

// future schema is refused, not downgraded
{
  const fs = createFakeFs()
  const text = JSON.stringify({ version: 99, seq: 1, tasks: [], future: true })
  seedBoard(fs, PROJECT, text)
  const result = await read(fs)
  check('a future board version is refused', isFailure(result, 'unsupported-version'), JSON.stringify(result))
  check('and the file is untouched', boardText(fs, PROJECT) === text)
}

// invalid JSON is refused and untouched
{
  const fs = createFakeFs()
  seedBoard(fs, PROJECT, '{ not json')
  const result = await read(fs)
  check('invalid JSON is refused', isFailure(result, 'unparseable'))
  check('and the file is untouched', boardText(fs, PROJECT) === '{ not json')
}

// v1 migration
{
  const fs = createFakeFs()
  seedBoard(
    fs,
    PROJECT,
    JSON.stringify({
      version: 1,
      seq: 3,
      tasks: [
        { id: 'T-1', status: 'claimed', blockedBy: ['T-2'], dispatch: { attempts: 2 }, assignee: { name: '@a' }, history: [] },
        { id: 'T-2', status: 'done', history: [] },
      ],
    }),
  )
  const result = await read(fs)
  check('v1 board migrates', result.ok === true && result.board.version === 2, JSON.stringify(result))
  const first = result.board.tasks[0]
  check('v1 blockedBy becomes dependsOn', first.dependsOn.join(',') === 'T-2', JSON.stringify(first.dependsOn))
  check('v1 claimed becomes pending', first.status === 'pending', first.status)
  check('v1 attempt count survives', first.attempts === 2, String(first.attempts))
  check('migration releases the old claim', first.assignee === null, JSON.stringify(first.assignee))
  check('migration pauses dispatch', result.board.dispatch.state === 'paused')
  check('migration records a history entry', first.history.some((entry) => entry.by === 'migration'))
}

// lost CAS race re-applies the mutation to fresh content
{
  const fs = createFakeFs()
  seedBoard(fs, PROJECT, JSON.stringify({ version: 2, seq: 7, tasks: [] }))
  let raced = false
  fs.hooks.beforeWrite = ({ write }) => {
    if (raced) return undefined
    raced = true
    write(JSON.stringify({ version: 2, seq: 8, tasks: [{ id: 'T-6', title: 'foreign' }] }))
    return 'stale'
  }
  const result = await updateBoard(
    { fs },
    {
      projectPath: PROJECT,
      mutate: (board) => ({ ...board, seq: board.seq + 1, tasks: board.tasks.concat([{ id: 'T-' + board.seq, title: 'mine' }]) }),
    },
  )
  check('a stale write retries', result.ok === true, JSON.stringify(result))
  check('the foreign task survives', result.board.tasks.some((task) => task.id === 'T-6'), JSON.stringify(result.board.tasks.map((task) => task.id)))
  check('the mutation is applied exactly once', result.board.tasks.filter((task) => task.title === 'mine').length === 1)
}

// history is capped, with the creation entry kept
{
  const fs = createFakeFs()
  const history = []
  for (let index = 0; index < MAX_HISTORY + 10; index++) {
    history.push({ at: '2026-01-01T00:00:00.000Z', by: '@a', from: 'pending', to: 'pending', note: 'entry ' + String(index) })
  }
  seedBoard(fs, PROJECT, JSON.stringify({ version: 2, seq: 2, tasks: [{ id: 'T-1', history }] }))
  const result = await read(fs)
  const kept = result.board.tasks[0].history
  check('history is capped', kept.length === MAX_HISTORY, String(kept.length))
  check('the creation entry is kept', kept[0].note === 'entry 0', kept[0].note)
  check('the newest entry is kept', kept[kept.length - 1].note === 'entry ' + String(history.length - 1))
}

// worktree / merge-request fields: defaults and roundtrip
{
  const fs = createFakeFs()
  seedBoard(fs, PROJECT, JSON.stringify({ version: 2, seq: 2, tasks: [{ id: 'T-1', title: 'legacy' }] }))
  const legacy = await read(fs)
  const task = legacy.board.tasks[0]
  check(
    'a legacy task defaults the worktree fields',
    task.base === null && task.target === null && task.branch === null && task.worktree === null && task.commit === null,
    JSON.stringify({ base: task.base, target: task.target, branch: task.branch, worktree: task.worktree, commit: task.commit }),
  )
  check(
    'a legacy task defaults actualFiles, requiredRole and merge',
    Array.isArray(task.actualFiles) && task.actualFiles.length === 0 && task.requiredRole === null && task.merge === null,
    JSON.stringify({ actualFiles: task.actualFiles, requiredRole: task.requiredRole, merge: task.merge }),
  )
  check(
    'dispatch.worktree defaults to the internal root with no enabled switch',
    legacy.board.dispatch.worktree.root === '.worktrees' && legacy.board.dispatch.worktree.enabled === undefined,
    JSON.stringify(legacy.board.dispatch.worktree),
  )
}

const BASE_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)
const MERGE = {
  status: 'open',
  base: BASE_SHA,
  target: 'main',
  head: HEAD_SHA,
  declaredFiles: ['scripts/a.gd'],
  actualFiles: ['scripts/a.gd', 'scripts/b.gd'],
  tests: 'npm run verify',
  reviewer: null,
  conflict: null,
  at: '2026-01-01T00:00:00.000Z',
}
{
  const fs = createFakeFs()
  seedBoard(
    fs,
    PROJECT,
    JSON.stringify({
      version: 2,
      seq: 2,
      dispatch: { state: 'paused', worktree: { root: 'build/worktrees' } },
      tasks: [
        {
          id: 'T-1',
          title: 'worktree task',
          base: BASE_SHA,
          target: 'main',
          branch: 'task/T-1',
          worktree: 'C:/demo/mm13d/.worktrees/T-1',
          commit: HEAD_SHA,
          actualFiles: ['scripts/a.gd', 'scripts/a.gd', ' scripts/b.gd '],
          requiredRole: 'reviewer',
          merge: MERGE,
        },
      ],
    }),
  )
  const loaded = await read(fs)
  const t = loaded.board.tasks[0]
  check(
    'task worktree fields roundtrip',
    t.base === BASE_SHA && t.target === 'main' && t.branch === 'task/T-1' && t.worktree === 'C:/demo/mm13d/.worktrees/T-1' && t.commit === HEAD_SHA,
    JSON.stringify(t),
  )
  check('actualFiles are deduplicated and trimmed', t.actualFiles.join('|') === 'scripts/a.gd|scripts/b.gd', JSON.stringify(t.actualFiles))
  check('requiredRole roundtrips', t.requiredRole === 'reviewer', String(t.requiredRole))
  check(
    'the merge record roundtrips',
    t.merge !== null &&
      t.merge.status === 'open' &&
      t.merge.base === BASE_SHA &&
      t.merge.target === 'main' &&
      t.merge.head === HEAD_SHA &&
      t.merge.declaredFiles.join(',') === 'scripts/a.gd' &&
      t.merge.actualFiles.join(',') === 'scripts/a.gd,scripts/b.gd' &&
      t.merge.tests === 'npm run verify' &&
      t.merge.reviewer === null &&
      t.merge.conflict === null &&
      t.merge.at === '2026-01-01T00:00:00.000Z',
    JSON.stringify(t.merge),
  )
  check('a merge record carries no phase decisions of its own', t.merge.verdict === undefined && t.review === null && t.test === null, JSON.stringify({ merge: t.merge.verdict, review: t.review, test: t.test }))
  check(
    'dispatch.worktree roundtrips its internal root',
    loaded.board.dispatch.worktree.root === 'build/worktrees' && loaded.board.dispatch.worktree.enabled === undefined,
    JSON.stringify(loaded.board.dispatch.worktree),
  )
  const written = await updateBoard({ fs }, { projectPath: PROJECT, mutate: (board) => board })
  check('a worktree/MR board writes back through the CAS', written.ok === true, JSON.stringify(written))
  const again = await read(fs)
  check(
    'the worktree/MR fields survive a write',
    again.board.tasks[0].merge !== null && again.board.tasks[0].worktree === t.worktree && again.board.dispatch.worktree.root === 'build/worktrees',
  )
}

// merge objects are repaired member by member, never dropped wholesale
{
  const fs = createFakeFs()
  seedBoard(
    fs,
    PROJECT,
    JSON.stringify({
      version: 2,
      seq: 3,
      tasks: [
        { id: 'T-1', merge: { status: 7, base: 3, declaredFiles: ['scripts/a.gd', 5, ' scripts/a.gd '], actualFiles: 'nope', tests: {}, reviewer: 9, conflict: true, at: 5 } },
        { id: 'T-2', merge: 'open' },
      ],
    }),
  )
  const loaded = await read(fs)
  const first = loaded.board.tasks[0].merge
  check(
    'a malformed merge keeps only typed members',
    first.status === null && first.base === null && first.target === null && first.head === null && first.tests === null && first.reviewer === null && first.at === null,
    JSON.stringify(first),
  )
  check('merge file lists are cleaned', first.declaredFiles.join(',') === 'scripts/a.gd' && first.actualFiles.length === 0, JSON.stringify(first))
  check('a boolean merge conflict is preserved', first.conflict === true)
  check('a non-object merge is null', loaded.board.tasks[1].merge === null)
}

// review/test phase records are typed members
{
  const fs = createFakeFs()
  const when = '2026-02-01T00:00:00.000Z'
  seedBoard(
    fs,
    PROJECT,
    JSON.stringify({
      version: 2,
      seq: 4,
      tasks: [
        {
          id: 'T-1',
          status: 'testing',
          review: { status: 'approved', by: 'rev', at: when, reasons: 'looks good', attempt: 2 },
          test: { status: 'passed', by: 'tester', at: when, evidence: 'npm run verify', attempt: 1 },
        },
        { id: 'T-2', status: 'reviewing', review: { status: 'changes-requested', by: 'rev', at: when, reasons: 'fix x', attempt: 1 }, test: { status: 'bogus' } },
        { id: 'T-3', review: { status: 'bogus' }, test: 'passed' },
        { id: 'T-4', status: 'done' },
      ],
    }),
  )
  const loaded = await read(fs)
  const first = loaded.board.tasks[0]
  check(
    'a review round trips',
    first.review !== null &&
      first.review.status === 'approved' &&
      first.review.by === 'rev' &&
      first.review.at === when &&
      first.review.reasons === 'looks good' &&
      first.review.attempt === 2,
    JSON.stringify(first.review),
  )
  check(
    'a test round trips',
    first.test !== null &&
      first.test.status === 'passed' &&
      first.test.by === 'tester' &&
      first.test.at === when &&
      first.test.evidence === 'npm run verify' &&
      first.test.attempt === 1,
    JSON.stringify(first.test),
  )
  check('the testing phase is preserved', first.status === 'testing', first.status)
  check('a changes-requested review round trips', loaded.board.tasks[1].review.status === 'changes-requested', JSON.stringify(loaded.board.tasks[1].review))
  check('an unknown review status is dropped', loaded.board.tasks[2].review === null, JSON.stringify(loaded.board.tasks[2].review))
  check('an unknown test status is dropped', loaded.board.tasks[1].test === null && loaded.board.tasks[2].test === null, JSON.stringify(loaded.board.tasks[1].test))
  check(
    'an old done task stays done without phase records',
    loaded.board.tasks[3].status === 'done' && loaded.board.tasks[3].review === null && loaded.board.tasks[3].test === null,
    loaded.board.tasks[3].status,
  )
  const written = await updateBoard({ fs }, { projectPath: PROJECT, mutate: (board) => board })
  const again = await read(fs)
  check(
    'the phase records survive a write',
    written.ok === true && again.board.tasks[0].review.status === 'approved' && again.board.tasks[0].test.status === 'passed',
    JSON.stringify(written),
  )
}

// the phase-machine statuses are all valid; unknown statuses fall back to pending
{
  const fs = createFakeFs()
  seedBoard(
    fs,
    PROJECT,
    JSON.stringify({
      version: 2,
      seq: 8,
      tasks: [
        { id: 'T-1', status: 'pending' },
        { id: 'T-2', status: 'running' },
        { id: 'T-3', status: 'reviewing' },
        { id: 'T-4', status: 'testing' },
        { id: 'T-5', status: 'done' },
        { id: 'T-6', status: 'blocked' },
        { id: 'T-7', status: 'cancelled' },
        { id: 'T-8', status: 'shipped' },
      ],
    }),
  )
  const loaded = await read(fs)
  const statuses = loaded.board.tasks.map((task) => task.status)
  check(
    'all seven phase statuses load',
    statuses.slice(0, 7).join(',') === 'pending,running,reviewing,testing,done,blocked,cancelled',
    statuses.join(','),
  )
  check('an unknown status falls back to pending', statuses[7] === 'pending', statuses[7])
}

// dispatch.worktree normalisation: project-relative, never absolute or escaping
{
  check(
    'worktree normalisation defaults an empty input',
    normaliseWorktree({}).root === '.worktrees' && normaliseWorktree({}).enabled === undefined,
    JSON.stringify(normaliseWorktree({})),
  )
  check('an absolute worktree root falls back', normaliseWorktree({ root: '/tmp/wt' }).root === '.worktrees')
  check('a Windows drive worktree root falls back', normaliseWorktree({ root: 'C:/wt' }).root === '.worktrees')
  check('an escaping worktree root falls back', normaliseWorktree({ root: '../outside' }).root === '.worktrees')
  check('a nested worktree root is normalised to POSIX', normaliseWorktree({ root: 'tmp\\worktrees\\' }).root === 'tmp/worktrees')
  check(
    'a leftover enabled flag is dropped, not honoured',
    normaliseWorktree({ enabled: false, root: 'wt' }).root === 'wt' && normaliseWorktree({ enabled: false, root: 'wt' }).enabled === undefined,
    JSON.stringify(normaliseWorktree({ enabled: false, root: 'wt' })),
  )
  const dispatch = normaliseDispatch({ worktree: { enabled: true, root: '/outside' }, maxConcurrent: 1 })
  check(
    'normaliseDispatch carries a normalised worktree without an enabled switch',
    dispatch.worktree.root === '.worktrees' && dispatch.worktree.enabled === undefined,
    JSON.stringify(dispatch.worktree),
  )
  const fs = createFakeFs()
  seedBoard(fs, PROJECT, JSON.stringify({ version: 2, seq: 2, tasks: [], dispatch: { worktree: { enabled: true, root: '/etc/wt' } } }))
  const loaded = await read(fs)
  check(
    'a board read normalises an absolute worktree root and drops enabled',
    loaded.board.dispatch.worktree.root === '.worktrees' && loaded.board.dispatch.worktree.enabled === undefined,
    JSON.stringify(loaded.board.dispatch.worktree),
  )
}

// ── role profiles: defaults, custom profiles, validation, persistence ─────
{
  const fs = createFakeFs()
  const missing = await readRoleConfig({ fs }, { projectPath: PROJECT })
  check(
    'an absent roles.json exposes the default worker/reviewer/tester profiles',
    missing.source === 'default' &&
      missing.error === null &&
      missing.config.profiles.worker.role === 'worker' &&
      missing.config.profiles.reviewer.stage === 'review' &&
      missing.config.profiles.tester.stage === 'test' &&
      missing.config.stages.review === 'reviewer' &&
      missing.config.defaultProfile === 'worker',
    JSON.stringify(missing.config),
  )
  check(
    'the default profile carries context, permissions and prompt',
    missing.config.profiles.reviewer.context === 'fresh' &&
      Array.isArray(missing.config.profiles.reviewer.permissions) &&
      missing.config.profiles.reviewer.prompt === '' &&
      missing.config.profiles.reviewer.instances === 1,
    JSON.stringify(missing.config.profiles.reviewer),
  )

  const custom = normaliseRoleConfig({
    profiles: {
      worker: { instances: 2, skills: ['base'] },
      'godot-reviewer': { role: 'reviewer', stage: 'review', instances: 2, skills: ['dsh-plugin-workflow'], context: 'fork', permissions: ['read-only', 'review'], prompt: 'Check Godot idioms.' },
    },
    stages: { review: 'godot-reviewer' },
    defaultProfile: 'godot-reviewer',
  })
  check(
    'a custom profile is kept and bound to its stage',
    custom.profiles['godot-reviewer'].role === 'reviewer' &&
      custom.profiles['godot-reviewer'].instances === 2 &&
      custom.profiles['godot-reviewer'].context === 'fork' &&
      custom.profiles['godot-reviewer'].permissions.join(',') === 'read-only,review' &&
      custom.profiles['godot-reviewer'].prompt === 'Check Godot idioms.' &&
      custom.stages.review === 'godot-reviewer' &&
      custom.stages.implement === 'worker' &&
      custom.stages.test === 'tester',
    JSON.stringify({ stages: custom.stages, profile: custom.profiles['godot-reviewer'] }),
  )
  check('the defaults survive alongside the custom profile', custom.profiles.worker.instances === 2 && custom.profiles.tester.role === 'tester', JSON.stringify(custom.profiles))
  check('the default profile may name a custom profile', custom.defaultProfile === 'godot-reviewer', custom.defaultProfile)

  const garbage = normaliseRoleConfig({ profiles: { 'Bad Name': { role: 'reviewer' }, 'godot-x': { role: 'nope' }, 'godot-y': 'nope' } })
  check(
    'invalid custom profiles are dropped without touching the defaults',
    garbage.profiles['godot-x'] === undefined &&
      garbage.profiles['godot-y'] === undefined &&
      garbage.profiles.worker.role === 'worker' &&
      garbage.profiles.reviewer.role === 'reviewer' &&
      garbage.stages.review === 'reviewer',
    JSON.stringify(garbage),
  )
}

{
  const valid = validateRoleProfile('godot-reviewer', { role: 'reviewer', instances: 2, skills: ['x'], context: 'fork', permissions: ['read-only', 'review'], prompt: 'p' })
  check('a valid profile passes strict validation', valid.ok === true && valid.profile.instances === 2 && valid.profile.stage === 'review', JSON.stringify(valid))
  const alias = validateRoleProfile('godot-reviewer', { kind: 'reviewer', concurrency: 3 })
  check('kind and concurrency are accepted aliases', alias.ok === true && alias.profile.role === 'reviewer' && alias.profile.instances === 3, JSON.stringify(alias))
  const bads = [
    ['Bad Name', { role: 'reviewer' }, 'invalid-role-name'],
    ['ok', {}, 'invalid-role-kind'],
    ['ok', { role: 'reviewer', stage: 'test' }, 'invalid-role-stage'],
    ['ok', { role: 'reviewer', instances: 0 }, 'invalid-role-instances'],
    ['ok', { role: 'reviewer', instances: 99 }, 'invalid-role-instances'],
    ['ok', { role: 'reviewer', skills: 'nope' }, 'invalid-role-skills'],
    ['ok', { role: 'reviewer', context: 'warm' }, 'invalid-role-context'],
    ['ok', { role: 'reviewer', permissions: ['admin', 'nope'] }, 'invalid-role-permissions'],
    ['ok', { role: 'reviewer', prompt: 5 }, 'invalid-role-prompt'],
  ]
  for (const entry of bads) {
    const result = validateRoleProfile(entry[0], entry[1])
    check('validation refuses ' + entry[2], result.ok === false && result.code === entry[2], JSON.stringify(result))
  }
  const base = defaultRoleConfig()
  check('binding a profile to its own stage passes', validateRoleBinding(base, 'review', 'reviewer').ok === true)
  check('binding a stage to a profile of another kind is refused', validateRoleBinding(base, 'test', 'reviewer').code === 'stage-mismatch')
  check('binding an unknown profile is refused', validateRoleBinding(base, 'review', 'nope').code === 'unknown-role-profile')
  check('binding an unknown stage is refused', validateRoleBinding(base, 'ship', 'reviewer').code === 'invalid-stage')
}

{
  const fs = createFakeFs()
  const config = normaliseRoleConfig({
    profiles: { 'godot-reviewer': { role: 'reviewer', stage: 'review', instances: 2, skills: ['x'], context: 'fork', permissions: ['read-only'], prompt: 'p' } },
    stages: { review: 'godot-reviewer' },
  })
  const written = await writeRoleConfig({ fs }, { projectPath: PROJECT, config: config })
  check('a role config is persisted to .agents/roles.json', written.ok === true && written.config.stages.review === 'godot-reviewer', JSON.stringify(written))
  const text = fs.files.get(rolesPath(PROJECT))
  check('the file is JSON with the custom profile', text !== undefined && JSON.parse(text.text).profiles['godot-reviewer'].instances === 2, text === undefined ? 'missing' : text.text.slice(0, 200))
  const loaded = await readRoleConfig({ fs }, { projectPath: PROJECT })
  check('the persisted config reads back with its stage binding', loaded.source === 'file' && loaded.config.stages.review === 'godot-reviewer' && loaded.config.profiles['godot-reviewer'].prompt === 'p', JSON.stringify(loaded))
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
