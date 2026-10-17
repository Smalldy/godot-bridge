// Board storage tests: schema, migration, CAS and the limits that keep a
// hand-edited board from corrupting the model.

import { join } from 'node:path'
import { readBoard, updateBoard, emptyBoard, boardPath, MAX_HISTORY } from '../../plugin/task-center/board.mjs'
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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
