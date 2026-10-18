// Board storage tests: schema, migration, CAS and the limits that keep a
// hand-edited board from corrupting the model.

import { join } from 'node:path'
import { readBoard, updateBoard, emptyBoard, boardPath, MAX_HISTORY } from '../../plugin/task-center/board.mjs'
import { normaliseDispatch, normaliseWorktree } from '../../plugin/task-center/schema.mjs'
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
  check('a merge record without a verdict normalises to null', t.merge.verdict === null, JSON.stringify(t.merge.verdict))
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

// the independent-test verdict is a typed member
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
        { id: 'T-1', merge: { status: 'open', base: BASE_SHA, head: HEAD_SHA, verdict: { status: 'passed', by: 'tester', at: when, output: 'ALL CHECKS PASSED' } } },
        { id: 'T-2', merge: { status: 'open', verdict: { status: 'bogus', by: 7, at: 5 } } },
        { id: 'T-3', merge: { status: 'open', verdict: 'passed' } },
      ],
    }),
  )
  const loaded = await read(fs)
  const first = loaded.board.tasks[0].merge
  check(
    'a passed verdict roundtrips',
    first.verdict !== null &&
      first.verdict.status === 'passed' &&
      first.verdict.by === 'tester' &&
      first.verdict.at === when &&
      first.verdict.output === 'ALL CHECKS PASSED',
    JSON.stringify(first.verdict),
  )
  check('an unknown verdict status is dropped', loaded.board.tasks[1].merge.verdict === null, JSON.stringify(loaded.board.tasks[1].merge.verdict))
  check('a non-object verdict is null', loaded.board.tasks[2].merge.verdict === null, JSON.stringify(loaded.board.tasks[2].merge.verdict))
  const written = await updateBoard({ fs }, { projectPath: PROJECT, mutate: (board) => board })
  const again = await read(fs)
  check(
    'the verdict survives a write',
    written.ok === true && again.board.tasks[0].merge.verdict.status === 'passed',
    JSON.stringify(written),
  )
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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
