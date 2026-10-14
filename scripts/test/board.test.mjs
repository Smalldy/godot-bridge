// Probe for the Host-side board storage layer (plugin/task-center/board.mjs).
//
// The property worth testing is not "it writes JSON" — it is that a lost
// version race re-applies the MUTATION to whatever is on disk now instead of
// writing back the result computed from stale content. A fake filesystem lets
// the race happen on demand, which no real filesystem can do reliably.
//
// board.mjs imports only `node:path`, so it loads in plain Node with no loader
// stubs.
//
// Run by `npm test` (see scripts/test/run.mjs); safe to run directly.
import { readBoard, updateBoard, boardPath, emptyBoard, BOARD_DIRECTORY, BOARD_FILENAME } from '../../plugin/task-center/board.mjs'

const PROJECT = 'J:\\demo\\mm13d'
let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || detail === undefined ? '' : '  -> ' + detail}`)
}

function staleError(message) {
  const error = new Error('FS_STALE_VERSION: ' + message)
  error.code = 'FS_STALE_VERSION'
  return error
}

/**
 * A filesystem with real version semantics and a hook that can interleave a
 * foreign write at exactly the moment our write is about to land.
 */
function createFs(seedText) {
  const files = new Map()
  const hooks = { beforeWrite: null }
  let counter = 0
  const bump = () => 'v' + String(++counter)
  const fs = {
    hooks,
    files,
    writes: 0,
    async resolve(path) {
      return { targetKey: path, displayPath: path }
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
      fs.writes++
      const key = target.targetKey
      const entry = files.get(key)
      if (expected !== undefined && expected.kind === 'createIfAbsent' && entry !== undefined) {
        throw staleError('the file already exists')
      }
      if (expected !== undefined && expected.kind === 'replaceIfVersion') {
        if (entry === undefined) throw staleError('the file is gone')
        if (entry.version !== expected.version) throw staleError('the version moved')
      }
      if (hooks.beforeWrite !== null) {
        const verdict = hooks.beforeWrite({
          key: key,
          content: content,
          write: (text) => files.set(key, { text: text, version: bump() }),
        })
        if (verdict === 'stale') throw staleError('lost the race to another writer')
      }
      const version = bump()
      files.set(key, { text: content, version: version })
      return { operation: entry === undefined ? 'create' : 'update', version: version, before: entry ? entry.text : null, after: content }
    },
  }
  if (seedText !== undefined) files.set(boardPath(PROJECT), { text: seedText, version: bump() })
  return fs
}

/** A pure mutator: it must work against whatever content it is handed. */
const appendTask = (id) => (board) => ({
  version: board.version,
  seq: board.seq + 1,
  tasks: board.tasks.concat([{ id: id, title: id }]),
  updatedAt: board.updatedAt,
})
const idsOf = (text) => JSON.parse(text).tasks.map((task) => task.id)
const boardText = (fs) => fs.files.get(boardPath(PROJECT)).text

// ── path and shape ─────────────────────────────────────────────────────────
check(
  'the board lives at .agents/tasks.json inside the project',
  boardPath(PROJECT).indexOf(BOARD_DIRECTORY) >= 0 && boardPath(PROJECT).indexOf(BOARD_FILENAME) >= 0,
  boardPath(PROJECT),
)
check('an empty board has no tasks and no locks', emptyBoard().tasks.length === 0 && emptyBoard().locks === undefined)

// ── the normal path ────────────────────────────────────────────────────────
let fs = createFs()
let result = await readBoard({ fs: fs }, { projectPath: PROJECT })
check('an absent board reads as empty, not as an error', result.ok === true && result.existed === false && result.version === null, JSON.stringify(result))
check('an absent board still exposes a version field', result.ok && result.board.version === 1)

result = await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-1') })
check('creating an absent board succeeds', result.ok === true && result.attempts === 1, JSON.stringify(result))
check('the created board holds the mutation', idsOf(boardText(fs)).join(',') === 'T-1', boardText(fs))
check('a board records when it was written', JSON.parse(boardText(fs)).updatedAt !== null)

result = await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-2') })
check('appending to an existing board succeeds', result.ok === true && result.attempts === 1)
check('both tasks survive the second write', idsOf(boardText(fs)).join(',') === 'T-1,T-2', boardText(fs))

// ── the property that matters: a lost race re-applies, never reverts ───────
fs = createFs()
await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-1') })
let raced = 0
fs.hooks.beforeWrite = (context) => {
  raced++
  if (raced > 1) return undefined
  // Another writer lands first: a hand edit or a second host.
  context.write(JSON.stringify({ version: 1, seq: 9, tasks: [{ id: 'T-8', title: 'written by someone else' }] }) + '\n')
  return 'stale'
}
result = await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-2') })
check('a lost race is retried, not surfaced', result.ok === true && result.attempts === 2, JSON.stringify(result))
check(
  'the foreign write survives and the mutation is re-applied on top',
  idsOf(boardText(fs)).join(',') === 'T-8,T-2',
  boardText(fs),
)
check('the mutation ran twice (re-applied, not reused)', raced === 2, String(raced))

// ── a race that never resolves ─────────────────────────────────────────────
fs = createFs()
await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-1') })
fs.hooks.beforeWrite = (context) => {
  context.write(boardText(fs))
  return 'stale'
}
result = await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-2'), attempts: 2 })
check('an unresolvable race reports stale with its attempt count', result.ok === false && result.code === 'stale' && result.attempts === 2, JSON.stringify(result))

// ── createIfAbsent race: the file appears between read and write ───────────
fs = createFs()
fs.hooks.beforeWrite = (context) => {
  context.write(JSON.stringify({ version: 1, seq: 5, tasks: [{ id: 'T-4', title: 'appeared' }] }) + '\n')
  return 'stale'
}
result = await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-1'), attempts: 1 })
check('a lost create race is reported when retries are exhausted', result.ok === false && result.code === 'stale', JSON.stringify(result))
fs.hooks.beforeWrite = null
result = await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-5') })
check('and the retry writes on top of the file that appeared', result.ok === true && idsOf(boardText(fs)).join(',') === 'T-4,T-5', boardText(fs))

// ── in-process serialisation ───────────────────────────────────────────────
fs = createFs()
const parallel = await Promise.all([
  updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-1') }),
  updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-2') }),
  updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-3') }),
])
check('concurrent updates all succeed', parallel.every((entry) => entry.ok === true), JSON.stringify(parallel.map((entry) => entry.code)))
check('no concurrent update is lost', idsOf(boardText(fs)).join(',') === 'T-1,T-2,T-3', boardText(fs))

// ── a file we cannot read is never overwritten ─────────────────────────────
fs = createFs('{ this is not json')
const before = boardText(fs)
result = await readBoard({ fs: fs }, { projectPath: PROJECT })
check('an unparseable board reads as unparseable', result.ok === false && result.code === 'unparseable', JSON.stringify(result))
result = await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: appendTask('T-1') })
check('an unparseable board is not written to', result.ok === false && result.code === 'unparseable')
check('and its bytes are unchanged', boardText(fs) === before, boardText(fs))
check('no write was even attempted', fs.writes === 0, String(fs.writes))

fs = createFs('{"hello":1}')
result = await readBoard({ fs: fs }, { projectPath: PROJECT })
check('a JSON file without tasks is unrecognisable', result.ok === false && result.code === 'unrecognisable', JSON.stringify(result))

// ── hand-written boards still allocate ids ─────────────────────────────────
fs = createFs(JSON.stringify({ tasks: [{ id: 'T-7', title: 'hand written' }] }))
result = await readBoard({ fs: fs }, { projectPath: PROJECT })
check('a minimal hand-written board is accepted', result.ok === true && result.board.tasks.length === 1, JSON.stringify(result))
check('its sequence continues past the highest id', result.ok && result.board.seq === 8, String(result.ok && result.board.seq))

// ── a mutator that declines ────────────────────────────────────────────────
fs = createFs()
result = await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: () => undefined })
check('a declining mutator reports no-change', result.ok === false && result.code === 'no-change', JSON.stringify(result))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
