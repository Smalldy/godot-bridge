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
// T-242: the cold done-card archive (settings, selection rules, staged writer).
import {
  ARCHIVE_DEFAULTS,
  appendToTaskArchive,
  archivePlanOf,
  normaliseArchiveSettings,
  readTaskArchive,
  removeFromTaskArchive,
  tasksArchivePath,
  validateArchiveSettingsPatch,
  writeTaskArchive,
} from '../../plugin/task-center/archive.mjs'
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

// ── T-242: the cold done-card archive ───────────────────────────────────────
// The 5.6 MB board was paid for on every heartbeat because it kept 226 finished
// cards. Finished work now moves to .agents/tasks-archive.json. These checks pin
// the rules that make that safe: the settings bounds, the selection (only done,
// keepDone, age + size triggers), and the archive's own staged/verified/backed-up
// CAS writer. The end-to-end sweep is covered by task-routes.test.mjs.
const NOW_242 = Date.parse('2026-11-26T00:00:00.000Z')
const DAY_242 = 24 * 60 * 60 * 1000
const archivedCard = (id, daysAgo, status) => ({
  id: id,
  title: id,
  status: status === undefined ? 'done' : status,
  kind: 'dev',
  updatedAt: new Date(NOW_242 - daysAgo * DAY_242).toISOString(),
  merge: null,
  history: [],
})
const archiveIo = (fs) => ({ fs: fs })
const archiveOpts = (extra) => Object.assign({ projectPath: PROJECT, now: NOW_242 }, extra === undefined ? {} : extra)

// ── the settings: defaults, clamping, and a refused save ────────────────────
{
  const defaults = normaliseArchiveSettings(null)
  check(
    'T-242 the archive is enabled by default with the documented defaults',
    defaults.enabled === true && defaults.doneAfterDays === ARCHIVE_DEFAULTS.doneAfterDays && defaults.keepDone === ARCHIVE_DEFAULTS.keepDone && defaults.maxBoardBytes === ARCHIVE_DEFAULTS.maxBoardBytes && defaults.lastSweepAt === null && defaults.lastSweep === null,
    JSON.stringify(defaults),
  )
  const clamped = normaliseArchiveSettings({ enabled: false, doneAfterDays: 0, keepDone: -5, maxBoardBytes: 1, lastSweepAt: '2026-11-25T10:00:00.000Z', lastSweep: { at: '2026-11-25T10:00:00.000Z', archived: 3, boardBytes: 900 } })
  check(
    'T-242 a stored value is clamped into range, never trusted (and diagnostics survive)',
    clamped.enabled === false && clamped.doneAfterDays === 1 && clamped.keepDone === 0 && clamped.maxBoardBytes === 64 * 1024 && clamped.lastSweepAt === '2026-11-25T10:00:00.000Z' && clamped.lastSweep.archived === 3,
    JSON.stringify(clamped),
  )
  const accepted = validateArchiveSettingsPatch({ doneAfterDays: 7, keepDone: 5, maxBoardBytes: 1024 * 1024, enabled: false })
  check('T-242 a valid settings patch is accepted field by field', accepted.ok === true && accepted.patch.doneAfterDays === 7 && accepted.patch.keepDone === 5 && accepted.patch.maxBoardBytes === 1024 * 1024 && accepted.patch.enabled === false, JSON.stringify(accepted))
  const refusals = [
    [{ doneAfterDays: 0 }, 'doneAfterDays'],
    [{ doneAfterDays: 9999 }, 'doneAfterDays'],
    [{ doneAfterDays: 1.5 }, 'doneAfterDays'],
    [{ keepDone: 999999 }, 'keepDone'],
    [{ keepDone: -1 }, 'keepDone'],
    [{ maxBoardBytes: 1024 }, 'maxBoardBytes'],
    [{ enabled: 'yes' }, 'enabled'],
    [{ nonsense: 1 }, 'nonsense'],
  ]
  const refused = refusals.filter((pair) => {
    const result = validateArchiveSettingsPatch(pair[0])
    return result.ok !== false || result.code !== 'invalid-archive-setting' || result.field !== pair[1]
  })
  check('T-242 every out-of-range or unknown archive setting is refused and named', refused.length === 0, JSON.stringify(refused))
  check('T-242 an empty patch is refused (a save must name a field)', validateArchiveSettingsPatch({}).ok === false)
}

// ── the selection: only done, keepDone, age and size triggers ───────────────
{
  const disabled = archivePlanOf({ tasks: [archivedCard('T-1', 40), archivedCard('T-2', 60)] }, { enabled: false }, NOW_242, 10 * 1024 * 1024)
  check('T-242 a disabled archive plans NOTHING (even a huge, ancient board)', disabled.due === null && disabled.candidates.length === 0 && disabled.overBytes === false, JSON.stringify(disabled))

  const mixed = { tasks: [archivedCard('T-1', 40), archivedCard('T-2', 50, 'running'), archivedCard('T-3', 60, 'reviewing'), archivedCard('T-4', 70, 'testing'), archivedCard('T-5', 80, 'pending'), archivedCard('T-6', 90, 'blocked')] }
  const onlyDone = archivePlanOf(mixed, { enabled: true, keepDone: 0, doneAfterDays: 1 }, NOW_242, 0)
  check(
    'T-242 only DONE cards are ever archived (running/reviewing/testing/pending/blocked stay)',
    onlyDone.candidates.length === 1 && onlyDone.candidates[0].id === 'T-1',
    JSON.stringify(onlyDone.candidates.map((task) => task.id)),
  )

  const many = []
  for (let index = 1; index <= 12; index += 1) many.push(archivedCard('T-' + String(index), index))
  const kept = archivePlanOf({ tasks: many }, { enabled: true, keepDone: 10, doneAfterDays: 1 }, NOW_242, 1024)
  check(
    'T-242 keepDone keeps the NEWEST done cards and archives the oldest beyond it',
    kept.keptCount === 10 && kept.beyondCount === 2 && kept.candidates.length === 2 && kept.candidates.map((task) => task.id).join(',') === 'T-12,T-11' && kept.due === 'age',
    JSON.stringify({ kept: kept.keptCount, beyond: kept.beyondCount, ids: kept.candidates.map((task) => task.id) }),
  )

  const recentBeyond = archivePlanOf({ tasks: many }, { enabled: true, keepDone: 10, doneAfterDays: 14 }, NOW_242, 1024)
  check(
    'T-242 a done card beyond keepDone is NOT cold before doneAfterDays',
    recentBeyond.candidates.length === 0 && recentBeyond.due === null && recentBeyond.coldCount === 0,
    JSON.stringify({ candidates: recentBeyond.candidates.length, cold: recentBeyond.coldCount }),
  )

  const size = []
  for (let index = 1; index <= 20; index += 1) size.push(archivedCard('T-' + String(index), index))
  const big = archivePlanOf({ tasks: size }, { enabled: true, keepDone: 5, doneAfterDays: 14, maxBoardBytes: 200000 }, NOW_242, 300000)
  check(
    'T-242 the size trigger archives the oldest done cards early (keepDone still protected)',
    big.overBytes === true && big.due === 'size' && big.candidates.length === 7 && big.candidates[0].id === 'T-20' && big.candidates.every((task) => ['T-1', 'T-2', 'T-3', 'T-4', 'T-5'].indexOf(task.id) < 0),
    JSON.stringify({ over: big.overBytes, due: big.due, ids: big.candidates.map((task) => task.id) }),
  )
  const recent = []
  for (let index = 1; index <= 20; index += 1) recent.push(archivedCard('T-' + String(index), 1))
  const under = archivePlanOf({ tasks: recent }, { enabled: true, keepDone: 5, doneAfterDays: 14, maxBoardBytes: 2 * 1024 * 1024 }, NOW_242, 300000)
  check('T-242 a board under the size threshold with no cold cards plans nothing', under.due === null && under.candidates.length === 0 && under.coldCount === 0, JSON.stringify({ due: under.due, cold: under.coldCount }))
  check('T-242 an empty board never plans anything', archivePlanOf({ tasks: [] }, null, NOW_242, 0).due === null)
}

// ── the archive file: read, staged write, backup, CAS retry, failure safety ─
{
  const fs = createFakeFs()
  const io = archiveIo(fs)
  const empty = await readTaskArchive(io, archiveOpts())
  check('T-242 a missing archive is an EMPTY archive, never an error', empty.ok === true && empty.tasks.length === 0 && empty.version === null && empty.existed === false, JSON.stringify(empty))

  const first = await appendToTaskArchive(io, archiveOpts(), [archivedCard('T-2', 2), archivedCard('T-1', 1)])
  const created = await readTaskArchive(io, archiveOpts())
  check(
    'T-242 the first append creates the archive (newest first) with no backup yet',
    first.ok === true && first.added.length === 2 && created.ok === true && created.tasks.map((task) => task.id).join(',') === 'T-1,T-2' && fs.files.get(tasksArchivePath(PROJECT) + '.bak') === undefined,
    JSON.stringify({ first: first.ok, ids: created.ok === true ? created.tasks.map((task) => task.id) : null }),
  )

  const second = await appendToTaskArchive(io, archiveOpts(), [archivedCard('T-2', 2), archivedCard('T-3', 3)])
  const backup = fs.files.get(tasksArchivePath(PROJECT) + '.bak')
  const backupIds = backup === undefined ? [] : JSON.parse(backup.text).tasks.map((task) => task.id)
  check(
    'T-242 a second append adds only NEW ids AND backs the previous archive up first',
    second.ok === true && second.added.join(',') === 'T-3' && backup !== undefined && backupIds.join(',') === 'T-1,T-2',
    JSON.stringify({ added: second.added, backupIds: backupIds }),
  )

  // A concurrent writer wins the CAS: the retry re-reads and keeps BOTH sets.
  const raceFs = createFakeFs()
  const raceIo = archiveIo(raceFs)
  let interfered = false
  raceFs.hooks.beforeWrite = function (intercept) {
    if (interfered === true || String(intercept.key).slice(-4) === '.tmp') return undefined
    interfered = true
    intercept.write(JSON.stringify({ version: 1, updatedAt: new Date(NOW_242).toISOString(), count: 1, tasks: [archivedCard('T-9', 9)] }))
    return 'stale'
  }
  const raced = await appendToTaskArchive(raceIo, archiveOpts(), [archivedCard('T-10', 10)])
  const racedArchive = await readTaskArchive(raceIo, archiveOpts())
  check(
    'T-242 a lost archive CAS retries against the fresh file: no card from either writer is lost',
    raced.ok === true && raced.attempts === 2 && racedArchive.ok === true && racedArchive.tasks.map((task) => task.id).sort().join(',') === 'T-10,T-9',
    JSON.stringify({ ok: raced.ok, attempts: raced.attempts, ids: racedArchive.ok === true ? racedArchive.tasks.map((task) => task.id) : null }),
  )

  // A promoted write that fails leaves the OLD archive intact.
  const failFs = createFakeFs()
  const failIo = archiveIo(failFs)
  await appendToTaskArchive(failIo, archiveOpts(), [archivedCard('T-1', 1)])
  const failWrite = failFs.writeText
  failFs.writeText = async function (target, content, expected, signal, policy) {
    if (String(target.targetKey) === tasksArchivePath(PROJECT)) throw new Error('disk full')
    return failWrite.call(this, target, content, expected, signal, policy)
  }
  const failed = await appendToTaskArchive(failIo, archiveOpts(), [archivedCard('T-2', 2)])
  const intact = await readTaskArchive(failIo, archiveOpts())
  check(
    'T-242 a failed promote leaves the previous archive intact (the cards stay on the board)',
    failed.ok === false && failed.code === 'archive-unwritable' && intact.ok === true && intact.tasks.map((task) => task.id).join(',') === 'T-1',
    JSON.stringify({ failure: failed.code, ids: intact.ok === true ? intact.tasks.map((task) => task.id) : null }),
  )

  // A staged payload that does not read back intact is never promoted.
  const stageFs = createFakeFs()
  const stageIo = archiveIo(stageFs)
  await appendToTaskArchive(stageIo, archiveOpts(), [archivedCard('T-1', 1)])
  const stageRead = stageFs.readText
  stageFs.readText = async function (target, signal) {
    if (String(target.targetKey).slice(-4) === '.tmp') return '{"version":1,"tasks":['
    return stageRead.call(this, target, signal)
  }
  const stageFailed = await writeTaskArchive(stageIo, archiveOpts(), [archivedCard('T-1', 1), archivedCard('T-2', 2)], null)
  const stageIntact = await readTaskArchive(stageIo, archiveOpts())
  check(
    'T-242 a staged archive that does not read back intact is never promoted',
    stageFailed.ok === false && stageFailed.code === 'archive-unwritable' && stageIntact.tasks.length === 1,
    JSON.stringify({ failure: stageFailed.code, cards: stageIntact.tasks.length }),
  )

  // A hand-edited file: duplicates and bad ids are dropped, the rest is readable.
  const handFs = createFakeFs()
  const handText = JSON.stringify({ version: 1, tasks: [archivedCard('T-1', 5), archivedCard('T-1', 5), { id: 'not-a-task', title: 'x' }, archivedCard('T-2', 1)] })
  handFs.files.set(tasksArchivePath(PROJECT), { text: handText, version: 'hand-1' })
  const hand = await readTaskArchive(archiveIo(handFs), archiveOpts())
  check('T-242 a hand-edited archive is read defensively (duplicates and foreign ids dropped)', hand.ok === true && hand.tasks.length === 2 && hand.version === 'hand-1', JSON.stringify(hand.ok === true ? hand.tasks.map((task) => task.id) : hand))

  const brokenFs = createFakeFs()
  brokenFs.files.set(tasksArchivePath(PROJECT), { text: '{not json', version: 'broken' })
  const broken = await readTaskArchive(archiveIo(brokenFs), archiveOpts())
  check('T-242 an unparseable archive is a readable failure, never a crash', broken.ok === false && broken.code === 'archive-unparseable', JSON.stringify(broken))

  const futureFs = createFakeFs()
  futureFs.files.set(tasksArchivePath(PROJECT), { text: JSON.stringify({ version: 9, tasks: [] }), version: 'future' })
  const future = await readTaskArchive(archiveIo(futureFs), archiveOpts())
  check('T-242 a future archive version is refused instead of downgraded', future.ok === false && future.code === 'archive-unsupported-version', JSON.stringify(future))
}

// ── the stale-copy reconcile (a concurrent edit beats the sweep) ────────────
// A sweep appends the planned cards, then a board CAS removes them. A card a user
// reopened/edited in that window stays hot, so the copy appended a moment ago is
// STALE and must come back out — but only that exact copy: a NEWER version that
// another sweep archived legitimately must survive.
{
  const fs = createFakeFs()
  const io = archiveIo(fs)
  const staleCard = archivedCard('T-2', 2)
  await appendToTaskArchive(io, archiveOpts(), [archivedCard('T-1', 1), staleCard])
  const edited = Object.assign({}, staleCard, { title: 'EDITED DURING SWEEP' })
  const mismatched = await removeFromTaskArchive(io, archiveOpts(), [edited])
  const unchanged = await readTaskArchive(io, archiveOpts())
  check(
    'T-242 a stale-copy removal is content-matched: a DIFFERENT archived version is not ours to delete',
    mismatched.ok === true && mismatched.removed.length === 0 && unchanged.ok === true && unchanged.tasks.map((task) => task.id).join(',') === 'T-1,T-2',
    JSON.stringify({ removed: mismatched.removed, archived: unchanged.ok === true ? unchanged.tasks.map((task) => task.id) : null }),
  )
  const removed = await removeFromTaskArchive(io, archiveOpts(), [staleCard])
  const after = await readTaskArchive(io, archiveOpts())
  check(
    'T-242 the matching stale copy is taken back out and everything else stays',
    removed.ok === true && removed.removed.join(',') === 'T-2' && after.ok === true && after.tasks.map((task) => task.id).join(',') === 'T-1',
    JSON.stringify({ removed: removed.removed, archived: after.ok === true ? after.tasks.map((task) => task.id) : null }),
  )
}

// ── the board file: archive fields survive every read/write ─────────────────
{
  const fs = createFakeFs()
  seedBoard(fs, PROJECT, textOf([taskOf('T-1', 'legacy')], 2))
  const legacy = await read(fs)
  check(
    'T-242 a legacy board reads back with the default archive settings and an empty index',
    legacy.ok === true && legacy.board.archive.enabled === true && legacy.board.archive.keepDone === ARCHIVE_DEFAULTS.keepDone && Array.isArray(legacy.board.archivedDone) && legacy.board.archivedDone.length === 0,
    JSON.stringify(legacy.ok === true ? legacy.board.archive : legacy),
  )

  const written = await updateBoard({ fs: fs }, {
    projectPath: PROJECT,
    mutate: (board) => Object.assign({}, board, {
      archive: Object.assign({}, board.archive, { keepDone: 5, lastSweepAt: '2026-11-25T00:00:00.000Z' }),
      archivedDone: [{ id: 'T-9', status: 'done', kind: 'dev', mergeStatus: 'merged', at: '2026-11-20T00:00:00.000Z' }, { id: 'nope' }],
    }),
  })
  const reloaded = await read(fs)
  check(
    'T-242 a saved archive setting and a normalised archived-card index survive the next read',
    written.ok === true && reloaded.ok === true && reloaded.board.archive.keepDone === 5 && reloaded.board.archive.lastSweepAt === '2026-11-25T00:00:00.000Z' && reloaded.board.archivedDone.length === 1 && reloaded.board.archivedDone[0].id === 'T-9' && reloaded.board.archivedDone[0].mergeStatus === 'merged',
    JSON.stringify(reloaded.ok === true ? reloaded.board.archivedDone : reloaded),
  )
  check('T-242 the archived-card index costs the cache nothing (the read is a hit after the write)', reloaded.cached === true, JSON.stringify({ cached: reloaded.cached }))
}

console.log(failures === 0 ? '\nPASS  board cache (T-232)' : '\nFAIL  ' + String(failures) + ' board cache check(s)')
process.exit(failures === 0 ? 0 : 1)
