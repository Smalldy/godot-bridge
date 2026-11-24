// T-232: the parsed-board cache.
//
// The board used to be decoded on EVERY read: a 5.24 MB tasks.json meant a full
// readText + JSON.parse + normalise per board/openProject/state/meta answer (8-9 s).
// The read layer now keeps the parsed board per (fs, board path) and accepts it only
// while the file's stat identity is unchanged. These checks prove the properties the
// cache must never trade away: one decode per file version, a write always reads the
// file (and refreshes the memo with what it wrote), a foreign write is seen on the
// next read, projects are isolated, concurrent first reads share one decode, and a
// failure never poisons the memo.

import { join } from 'node:path'
import { BOARD_VERSION, MAX_BOARD_BYTES, boardCacheStats, boardPath, readBoard, updateBoard } from '../../plugin/task-center/board.mjs'
import { createFakeFs, seedBoard, PROJECT } from './support/fixtures.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

const textOf = (tasks, seq) => JSON.stringify({ version: BOARD_VERSION, seq: seq === undefined ? tasks.length + 1 : seq, tasks: tasks })
const taskOf = (id, title, status) => ({ id: id, title: title, status: status === undefined ? 'pending' : status })

/** A fake fs that counts the file reads the cache is supposed to save. */
function countingFs() {
  const fs = createFakeFs()
  const counts = { readText: 0, stat: 0, writeText: 0 }
  const realRead = fs.readText
  const realStat = fs.stat
  const realWrite = fs.writeText
  fs.readText = async function (target, signal) {
    counts.readText += 1
    return realRead.call(this, target, signal)
  }
  fs.stat = async function (target, signal) {
    counts.stat += 1
    return realStat.call(this, target, signal)
  }
  fs.writeText = async function (...args) {
    counts.writeText += 1
    return realWrite.apply(fs, args)
  }
  fs.counts = counts
  return fs
}

const read = (fs, project) => readBoard({ fs: fs }, { projectPath: project === undefined ? PROJECT : project })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── one decode per file version ─────────────────────────────────────────────
{
  const fs = countingFs()
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'cached')], 2))
  const first = await read(fs)
  check('T-232 the first read decodes the board', first.ok === true && first.cached === false && first.board.tasks.length === 1 && fs.counts.readText === 1, JSON.stringify({ first: first.ok, cached: first.cached, reads: fs.counts.readText }))
  const second = await read(fs)
  check('T-232 an unchanged file is answered by the parsed board', second.ok === true && second.cached === true && second.board.tasks[0].title === 'cached', JSON.stringify({ cached: second.cached }))
  check('T-232 a cached read reads NO file, it only stats it', fs.counts.readText === 1 && fs.counts.stat === 2, JSON.stringify(fs.counts))
  check(
    'T-232 the cached answer has the same shape as the decode',
    [first.version, first.existed, first.size, first.limit].join('|') === [second.version, second.existed, second.size, second.limit].join('|') && Object.keys(first).sort().join(',') === Object.keys(second).sort().join(','),
    JSON.stringify({ first: first, second: second }),
  )
  const stats = boardCacheStats(fs)
  check('T-232 the per-fs counters report one decode and one hit', stats.parses === 1 && stats.hits === 1, JSON.stringify(stats))
  console.log('PASS  T-232 a repeated board read is a stat, not a 5 MB decode')
}

// ── the stat identity: version, size and mtime ──────────────────────────────
{
  const fs = countingFs()
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'before')], 2))
  await read(fs)
  fs.files.set(boardPath(PROJECT), { text: textOf([taskOf('T-1', 'after'), taskOf('T-2', 'new')], 3), version: 'v-foreign' })
  const changed = await read(fs)
  check(
    'T-232 a changed version re-decodes the file',
    changed.ok === true && changed.cached === false && changed.board.tasks.length === 2 && changed.board.tasks[0].title === 'after' && changed.version === 'v-foreign' && fs.counts.readText === 2,
    JSON.stringify({ cached: changed.cached, reads: fs.counts.readText }),
  )

  // The same version and the same byte size, only the mtime moved: a same-size
  // rewrite would look exactly like this if mtime were not part of the identity.
  const mtimeFs = countingFs()
  let mtimeMs = 1000
  const realStat = mtimeFs.stat
  mtimeFs.stat = async function (target, signal) {
    const info = await realStat.call(this, target, signal)
    return info === undefined ? info : Object.assign({}, info, { mtimeMs: mtimeMs })
  }
  seedBoard(mtimeFs, PROJECT, textOf([taskOf('T-1', 'aaaa')], 2))
  const stamped = await read(mtimeFs)
  const swapped = textOf([taskOf('T-1', 'bbbb')], 2)
  check('T-232 the same-size rewrite really is the same version and size', Buffer.byteLength(swapped, 'utf8') === Buffer.byteLength(textOf([taskOf('T-1', 'aaaa')], 2), 'utf8'), String(Buffer.byteLength(swapped, 'utf8')))
  mtimeFs.files.set(boardPath(PROJECT), { text: swapped, version: 'seed' })
  mtimeMs = 2000
  const restamped = await read(mtimeFs)
  check(
    'T-232 the mtime is part of the identity (a same-size rewrite is never stale)',
    stamped.cached === false && restamped.ok === true && restamped.cached === false && restamped.board.tasks[0].title === 'bbbb' && mtimeFs.counts.readText === 2,
    JSON.stringify({ cached: restamped.cached, title: restamped.board.tasks[0].title, reads: mtimeFs.counts.readText }),
  )
  console.log('PASS  T-232 the cached board is keyed on version/size/mtime, never on the path alone')
}

// ── a stat with nothing to validate against disables the memo ───────────────
{
  // A facade that reports neither a version nor a size nor an mtime cannot prove
  // the file is unchanged, so the memo must refuse to answer for it (slow but
  // correct) instead of serving every rewrite as a hit.
  const fs = countingFs()
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'one')], 2))
  const realStat = fs.stat
  fs.stat = async function (target, signal) {
    const info = await realStat.call(this, target, signal)
    return info === undefined ? info : { type: info.type }
  }
  const first = await read(fs)
  fs.files.set(boardPath(PROJECT), { text: textOf([taskOf('T-1', 'two')], 2), version: 'v-second' })
  const second = await read(fs)
  check(
    'T-232 a stat with no version/size/mtime is never cached',
    first.ok === true && first.cached === false && second.ok === true && second.cached === false && second.board.tasks[0].title === 'two' && fs.counts.readText === 2,
    JSON.stringify({ first: first.cached, second: second.cached, title: second.board.tasks[0].title, reads: fs.counts.readText }),
  )
  console.log('PASS  T-232 no identity in the stat means no memo, never a guessed hit')
}

// ── a removed or oversized board never comes from the memo ──────────────────
{
  const fs = countingFs()
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'alive')], 2))
  await read(fs)
  fs.files.delete(boardPath(PROJECT))
  const gone = await read(fs)
  check('T-232 a removed board is an empty board, not the memo', gone.ok === true && gone.existed === false && gone.board.tasks.length === 0 && gone.cached === false, JSON.stringify(gone))
  seedBoard(fs, PROJECT, textOf([taskOf('T-2', 'back')], 2))
  const back = await read(fs)
  check('T-232 a re-created board is decoded', back.ok === true && back.cached === false && back.board.tasks[0].id === 'T-2', JSON.stringify({ cached: back.cached }))

  // A stat that reports an oversized file must be refused BEFORE the memo is
  // consulted: the cap is a rule about the file, not about what we remember.
  const capFs = countingFs()
  seedBoard(capFs, PROJECT, textOf([taskOf('T-1', 'small')], 2))
  await read(capFs)
  const realStat = capFs.stat
  capFs.stat = async function (target, signal) {
    const info = await realStat.call(this, target, signal)
    return info === undefined ? info : Object.assign({}, info, { size: MAX_BOARD_BYTES + 1 })
  }
  const refused = await read(capFs)
  check('T-232 an oversized board is refused, never served from the memo', refused.ok === false && refused.code === 'too-large', JSON.stringify(refused))
  console.log('PASS  T-232 the memo never answers for a file that changed, vanished or outgrew the cap')
}

// ── writes: bypass the memo, refresh it with what was written ───────────────
{
  const fs = countingFs()
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'before')], 2))
  await read(fs)
  const written = await updateBoard(
    { fs: fs },
    {
      projectPath: PROJECT,
      mutate: function (board) {
        return Object.assign({}, board, { tasks: board.tasks.map((task) => Object.assign({}, task, { title: 'after' })) })
      },
    },
  )
  check('T-232 a write reads the FILE, never the memo', written.ok === true && fs.counts.readText === 2, JSON.stringify({ ok: written.ok, reads: fs.counts.readText }))
  check('T-232 the write answers what it wrote', written.board.tasks[0].title === 'after' && written.version !== null, JSON.stringify({ title: written.board.tasks[0].title }))
  const after = await read(fs)
  check(
    'T-232 the read right after a write is the written board, with no decode',
    after.ok === true && after.cached === true && after.board.tasks[0].title === 'after' && fs.counts.readText === 2 && after.version === written.version,
    JSON.stringify({ cached: after.cached, reads: fs.counts.readText, title: after.board.tasks[0].title }),
  )

  // Another process writes between our reads (the fake fs bumps the version the
  // way the real facade does): the very next read must decode the new file.
  fs.files.set(boardPath(PROJECT), { text: textOf([taskOf('T-9', 'foreign')], 9), version: 'v-foreign' })
  const seen = await read(fs)
  check(
    'T-232 a write by another process is seen on the next read',
    seen.ok === true && seen.cached === false && seen.board.tasks[0].title === 'foreign' && fs.counts.readText === 3,
    JSON.stringify({ cached: seen.cached, reads: fs.counts.readText }),
  )
  console.log('PASS  T-232 a write never reads through the memo and never leaves a pre-write snapshot in it')
}

// ── a lost CAS re-applies on the FRESH board, and the memo follows ──────────
{
  const fs = countingFs()
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'ours')], 2))
  await read(fs)
  let interfered = false
  fs.hooks.beforeWrite = function (intercept) {
    if (interfered === true) return undefined
    interfered = true
    // Another process wins the race first, so our expected version is stale.
    intercept.write(textOf([taskOf('T-1', 'ours'), taskOf('T-2', 'foreign')], 3))
    return 'stale'
  }
  const written = await updateBoard(
    { fs: fs },
    {
      projectPath: PROJECT,
      mutate: function (board) {
        // Only OUR card is touched: the foreign card that won the race must
        // survive the retry (a retry against the pre-write board would drop it).
        return Object.assign({}, board, { tasks: board.tasks.map((task) => (String(task.id) === 'T-1' ? Object.assign({}, task, { title: 'renamed' }) : task)) })
      },
    },
  )
  check(
    'T-232 a lost CAS re-applies the mutation on the freshly read board',
    written.ok === true && written.attempts === 2 && written.board.tasks.length === 2 && written.board.tasks[0].title === 'renamed' && written.board.tasks[1].title === 'foreign',
    JSON.stringify({ ok: written.ok, attempts: written.attempts, tasks: written.board === undefined ? null : written.board.tasks.map((task) => task.title) }),
  )
  const after = await read(fs)
  check(
    'T-232 after the retried write the memo holds the written board (foreign card included)',
    after.ok === true && after.cached === true && after.board.tasks.length === 2 && after.board.tasks[1].title === 'foreign' && after.version === written.version,
    JSON.stringify({ cached: after.cached, tasks: after.board.tasks.map((task) => task.title) }),
  )
  console.log('PASS  T-232 the cache cannot weaken the CAS: the retry reads the file and the answer is what landed')
}

// ── the T-238 write shapes: a lease-only write and a declined renewal ───────
// The heartbeat only writes when a lease is inside its renewal window, and then
// it moves just leaseUntil/updatedAt on the due cards. Two board-level guarantees
// back that: a lease-only write still refreshes the memo with what it wrote, and a
// mutator that declines (nothing is due by the time the write runs) touches NOTHING
// — the file keeps its identity and the memo keeps serving it.
{
  const fs = countingFs()
  const stale = new Date('2026-03-01T00:00:00.000Z').toISOString()
  const renewed = new Date('2026-03-01T00:30:00.000Z').toISOString()
  const running = (id, lease, updated) => ({ id: id, title: 'running', status: 'running', assignee: { name: 'w', session: 's' }, leaseUntil: lease, updatedAt: updated })
  seedBoard(fs, PROJECT, textOf([running('T-1', stale, stale)], 2))
  const before = await read(fs)
  const written = await updateBoard(
    { fs: fs },
    {
      projectPath: PROJECT,
      now: Date.parse(renewed),
      // updateBoard's mutator returns the BOARD itself (state.apply wraps this in
      // the model's {ok, board} envelope); only the due card's lease moves.
      mutate: function (board) {
        return Object.assign({}, board, {
          tasks: board.tasks.map((task) => Object.assign({}, task, { leaseUntil: renewed, updatedAt: renewed })),
        })
      },
    },
  )
  const after = await read(fs)
  check(
    'T-238 a lease-only write is answered by the memo of what was written (new lease, no decode)',
    before.cached === false && written.ok === true && after.cached === true && after.board.tasks[0].leaseUntil === renewed && after.board.tasks[0].updatedAt === renewed && fs.counts.readText === 2,
    JSON.stringify({ cached: after.cached, lease: after.board.tasks[0].leaseUntil, reads: fs.counts.readText }),
  )

  // The renewal declines when the board moved on between its read and the write
  // (nothing due any more). That must not rewrite a no-op board.
  const quietText = fs.files.get(boardPath(PROJECT)).text
  const quietVersion = fs.files.get(boardPath(PROJECT)).version
  const declined = await updateBoard({ fs: fs }, { projectPath: PROJECT, mutate: () => null })
  const stillQuiet = await read(fs)
  check(
    'T-238 a declined renewal writes NOTHING and leaves the memo alone',
    declined.ok === false &&
      declined.code === 'aborted' &&
      fs.counts.writeText === 1 &&
      fs.files.get(boardPath(PROJECT)).text === quietText &&
      fs.files.get(boardPath(PROJECT)).version === quietVersion &&
      stillQuiet.cached === true &&
      stillQuiet.board.tasks[0].leaseUntil === renewed,
    JSON.stringify({ declined: declined.code, writes: fs.counts.writeText, cached: stillQuiet.cached }),
  )
  console.log('PASS  T-238 a lease-only write refreshes the memo; a declined renewal leaves the file untouched')
}

// ── projects and hosts never share a board ──────────────────────────────────
{
  const fs = countingFs()
  const other = join(PROJECT, 'other-project')
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'project-a')], 2))
  seedBoard(fs, other, textOf([taskOf('T-2', 'project-b')], 2))
  const a1 = await read(fs)
  const b1 = await read(fs, other)
  const a2 = await read(fs)
  check(
    'T-232 projects are cached apart',
    a1.board.tasks[0].title === 'project-a' && b1.board.tasks[0].title === 'project-b' && a2.board.tasks[0].title === 'project-a' && a2.cached === true && b1.cached === false && fs.counts.readText === 2,
    JSON.stringify({ a: a1.board.tasks[0].title, b: b1.board.tasks[0].title, reads: fs.counts.readText }),
  )
  const fsA = countingFs()
  const fsB = countingFs()
  seedBoard(fsA, PROJECT, textOf([taskOf('T-1', 'host-a')], 2))
  seedBoard(fsB, PROJECT, textOf([taskOf('T-1', 'host-b')], 2))
  const hostA = await read(fsA)
  const hostB = await read(fsB)
  check(
    'T-232 two hosts sharing a path never share a board',
    hostA.board.tasks[0].title === 'host-a' && hostB.board.tasks[0].title === 'host-b' && hostA.cached === false && hostB.cached === false,
    JSON.stringify({ a: hostA.board.tasks[0].title, b: hostB.board.tasks[0].title }),
  )
  console.log('PASS  T-232 the key is (fs, board path): no cross-project and no cross-host reuse')
}

// ── concurrent first reads share ONE decode (single flight) ─────────────────
{
  const fs = createFakeFs()
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'flight')], 2))
  let reads = 0
  let release = null
  const realRead = fs.readText
  fs.readText = async function (target, signal) {
    reads += 1
    await new Promise((resolve) => {
      release = resolve
    })
    return realRead.call(this, target, signal)
  }
  const first = read(fs)
  await sleep(5)
  const second = read(fs)
  await sleep(5)
  check('T-232 the second concurrent reader starts while the first decode is in flight', reads === 1 && release !== null, JSON.stringify({ reads: reads }))
  release()
  const both = await Promise.all([first, second])
  check(
    'T-232 two concurrent first reads decode the file ONCE',
    reads === 1 && both[0].ok === true && both[1].ok === true && both[0].board.tasks[0].title === 'flight' && both[1].board.tasks[0].title === 'flight',
    JSON.stringify({ reads: reads, first: both[0].ok, second: both[1].ok }),
  )
  check('T-232 the decoder answers cached:false and the joiner cached:true', both[0].cached === false && both[1].cached === true, JSON.stringify({ first: both[0].cached, second: both[1].cached }))
  const third = await read(fs)
  check('T-232 the shared decode was stored, so the next read is warm', third.cached === true && reads === 1, JSON.stringify({ cached: third.cached, reads: reads }))
  const stats = boardCacheStats(fs)
  check('T-232 the counters report the shared read', stats.parses === 1 && stats.flights === 1, JSON.stringify(stats))
  console.log('PASS  T-232 overlapping polls cost ONE decode, not one per poll')
}

// ── a failure never poisons the memo ───────────────────────────────────────
{
  const fs = countingFs()
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'healthy')], 2))
  await read(fs)
  fs.files.set(boardPath(PROJECT), { text: '{not json', version: 'v-broken' })
  const broken = await read(fs)
  check('T-232 an unparseable board is a readable failure', broken.ok === false && broken.code === 'unparseable', JSON.stringify(broken))
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'repaired')], 2))
  const repaired = await read(fs)
  check(
    'T-232 the repaired file is decoded, never answered from the old memo',
    repaired.ok === true && repaired.cached === false && repaired.board.tasks[0].title === 'repaired' && fs.counts.readText === 3,
    JSON.stringify({ cached: repaired.cached, reads: fs.counts.readText }),
  )
  console.log('PASS  T-232 a failed read leaves no entry behind')
}

// ── the memo is bounded (a long-lived host cycles projects) ────────────────
{
  const fs = countingFs()
  const projects = []
  for (let index = 0; index < 17; index += 1) {
    const project = join(PROJECT, 'bounded-' + String(index))
    seedBoard(fs, project, textOf([taskOf('T-' + String(index + 1), 'p' + String(index))], 2))
    projects.push(project)
    await read(fs, project)
  }
  const stats = boardCacheStats(fs)
  check('T-232 reading more projects than the memo holds evicts the coldest', stats.evictions >= 1, JSON.stringify(stats))
  const before = fs.counts.readText
  const evicted = await read(fs, projects[0])
  check('T-232 the evicted project is decoded again', evicted.ok === true && evicted.cached === false && fs.counts.readText === before + 1, JSON.stringify({ cached: evicted.cached, reads: fs.counts.readText - before }))
  const recent = await read(fs, projects[16])
  check('T-232 the most recently read project is still memoised', recent.cached === true, JSON.stringify({ cached: recent.cached }))
  console.log('PASS  T-232 the per-host memo is bounded and evicts least-recently-read projects')
}

console.log(failures === 0 ? '\nPASS  board cache (T-232)' : '\nFAIL  ' + String(failures) + ' board cache check(s)')
process.exit(failures === 0 ? 0 : 1)
