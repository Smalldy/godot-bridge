// T-192: the card model (STAGE-CONTRACT §5).
//
// A NEW dev card must declare executable probes and fit the design-stage size
// budget (5 production files, 250 production lines, 6 acceptance criteria,
// 8 probes). "Production" excludes tests and the generated client/client.js.
// Cards that already exist on a board (written before this rule) are NOT
// silently rewritten or retroactively rejected; investigation cards are exempt.
//
// Covers the pure schema helpers, the model transitions, and the action surface
// the panel/tool actually call.

import { emptyBoard } from '../../plugin/task-center/board.mjs'
import { claimTask, createTask, findTask, submitTask, updateTask } from '../../plugin/task-center/service.mjs'
import {
  CARD_MODEL_LIMITS,
  productionChangeLines,
  productionFiles,
  productionLinesOfArtifact,
  validateCardModel,
} from '../../plugin/task-center/schema.mjs'
import { createFakeFs, createRig, seedBoard, PROJECT } from './support/fixtures.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const PROBES = { probes: [{ id: 'suite', command: 'npm test' }] }
const criteria = (count) => Array.from({ length: count }, (_, index) => 'criterion ' + String(index + 1)).join('\n')
const probeList = (count) => ({ probes: Array.from({ length: count }, (_, index) => ({ id: 'p' + String(index), command: 'npm test' })) })
const files = (count) => Array.from({ length: count }, (_, index) => 'plugin/file-' + String(index) + '.mjs')
const board = () => emptyBoard(T0)
const make = (input) => createTask(board(), input, T0, '@lead')

// ── the budget itself ──────────────────────────────────────────────────────
check(
  'the design budget is the contract budget (5 files / 250 lines / 6 criteria / 8 probes)',
  CARD_MODEL_LIMITS.files === 5 && CARD_MODEL_LIMITS.changedLines === 250 && CARD_MODEL_LIMITS.acceptance === 6 && CARD_MODEL_LIMITS.probes === 8,
  JSON.stringify(CARD_MODEL_LIMITS),
)

// ── create: probes are mandatory for a dev card ────────────────────────────
{
  const missing = make({ title: 'no probes' })
  check('a NEW dev card without probes is a typed refusal', missing.ok === false && missing.code === 'missing-probes', JSON.stringify(missing.code))
  check('the refusal is readable and names the shape', typeof missing.message === 'string' && missing.message.indexOf('verification.probes') >= 0 && missing.message.indexOf('{ id, command }') >= 0, missing.message)
  const declared = make({ title: 'with probes', verification: PROBES })
  check('a dev card with one executable probe is created', declared.ok === true && declared.task.verification.probes.length === 1, JSON.stringify(declared.ok === true ? declared.task.verification : declared.code))
  const investigation = make({ title: 'find the cause', kind: 'investigate' })
  check('an investigation card needs no probe', investigation.ok === true && investigation.task.verification.probes.length === 0, JSON.stringify(investigation.ok === true ? investigation.task.kind : investigation.code))
}

// ── create: the size limits are typed, readable refusals ───────────────────
{
  const tooManyFiles = make({ title: 'wide card', verification: PROBES, writeFiles: files(6) })
  check('more than five production files is refused', tooManyFiles.ok === false && tooManyFiles.code === 'too-many-files', JSON.stringify(tooManyFiles.ok === true ? 'created' : tooManyFiles.code))
  check('the over-limit refusal says to split the card at design time', typeof tooManyFiles.message === 'string' && tooManyFiles.message.indexOf('split the card at design time') >= 0, tooManyFiles.message)

  const generated = make({ title: 'ui card', verification: PROBES, writeFiles: files(5).concat(['client/client.js', 'scripts/test/task-admin.test.mjs']) })
  check('the generated bundle and test files are outside the file budget', generated.ok === true, JSON.stringify(generated.ok === true ? 'created' : generated.code))

  const tooManyCriteria = make({ title: 'many criteria', verification: PROBES, acceptance: criteria(7) })
  check('more than six acceptance criteria is refused', tooManyCriteria.ok === false && tooManyCriteria.code === 'too-many-acceptance', JSON.stringify(tooManyCriteria.ok === true ? 'created' : tooManyCriteria.code))
  const sixCriteria = make({ title: 'six criteria', verification: PROBES, acceptance: criteria(6) })
  check('six acceptance criteria still fit', sixCriteria.ok === true, JSON.stringify(sixCriteria.ok === true ? 'created' : sixCriteria.code))

  const tooManyProbes = make({ title: 'many probes', verification: probeList(9) })
  check('more than eight probes is refused', tooManyProbes.ok === false && tooManyProbes.code === 'too-many-probes', JSON.stringify(tooManyProbes.ok === true ? 'created' : tooManyProbes.code))
  const eightProbes = make({ title: 'eight probes', verification: probeList(8) })
  check('eight probes still fit', eightProbes.ok === true, JSON.stringify(eightProbes.ok === true ? 'created' : eightProbes.code))
}

// ── update: a dev card may not be shrunk out of the card model ─────────────
{
  const created = make({ title: 'dev card', verification: PROBES })
  const renamed = updateTask(created.board, 'T-1', { title: 'renamed', priority: 3 }, T0, '@lead')
  check('an unrelated update keeps the declared probes', renamed.ok === true && renamed.task.verification.probes.length === 1, JSON.stringify(renamed.ok === true ? renamed.task.verification : renamed.code))
  const cleared = updateTask(created.board, 'T-1', { verification: null }, T0, '@lead')
  check('an update cannot clear the probes of a dev card', cleared.ok === false && cleared.code === 'missing-probes', JSON.stringify(cleared.ok === true ? 'accepted' : cleared.code))
  const emptied = updateTask(created.board, 'T-1', { verification: { probes: [] } }, T0, '@lead')
  check('an update cannot replace the probes with an empty list', emptied.ok === false && emptied.code === 'missing-probes', JSON.stringify(emptied.ok === true ? 'accepted' : emptied.code))
  const widened = updateTask(created.board, 'T-1', { acceptance: criteria(7) }, T0, '@lead')
  check('an update cannot grow a card past six criteria', widened.ok === false && widened.code === 'too-many-acceptance', JSON.stringify(widened.ok === true ? 'accepted' : widened.code))
  const investigation = make({ title: 'investigation', kind: 'investigate' })
  const investigationUpdate = updateTask(investigation.board, 'T-1', { verification: null }, T0, '@lead')
  check('an investigation card is unaffected by the update rule', investigationUpdate.ok === true, JSON.stringify(investigationUpdate.ok === true ? 'accepted' : investigationUpdate.code))
}

// ── legacy cards: never silently rewritten, never retroactively rejected ───
// validateCardModel judges a WRITE (the card being designed/edited). A card that
// is already on the board is only checked through the fields an update actually
// supplies, so a legacy card keeps its probe-less shape until someone opts in.
{
  const model = make({ title: 'normalized legacy', verification: PROBES })
  const legacyBoard = Object.assign({}, model.board, {
    tasks: model.board.tasks.map((task) => Object.assign({}, task, { verification: { probes: [] }, acceptance: criteria(7) })),
  })
  const untouched = updateTask(legacyBoard, 'T-1', { priority: 2 }, T0, '@lead')
  check('an unrelated update of a legacy card is accepted', untouched.ok === true, JSON.stringify(untouched.ok === true ? 'accepted' : untouched.code))
  check('and it does not silently add or remove probes', untouched.ok === true && untouched.task.verification.probes.length === 0, JSON.stringify(untouched.ok === true ? untouched.task.verification : null))
  const adopted = updateTask(legacyBoard, 'T-1', { verification: PROBES }, T0, '@lead')
  check('a legacy card can adopt probes explicitly', adopted.ok === true && adopted.task.verification.probes.length === 1, JSON.stringify(adopted.ok === true ? adopted.task.verification : adopted.code))
}

// ── the generated bundle is not a production change ────────────────────────
{
  check('the generated bundle is filtered out of the declared files', productionFiles(['client/client.js', 'plugin/a.mjs', 'scripts/test/x.test.mjs', './plugin/a.mjs']).join(',') === 'plugin/a.mjs', JSON.stringify(productionFiles(['client/client.js', 'plugin/a.mjs', 'scripts/test/x.test.mjs', './plugin/a.mjs'])))
  const lines = productionChangeLines([
    { path: 'plugin/task-center/service.mjs', insertions: 200, deletions: 60 },
    { path: 'client/client.js', insertions: 900, deletions: 100 },
    { path: 'scripts/test/task-admin.test.mjs', insertions: 400, deletions: 10 },
  ])
  check('only production files count toward the line budget', lines === 260, String(lines))
  check('an unknown change list is not a zero', productionChangeLines(undefined) === null)
  check('a bundle-only candidate has a known production budget of 0', productionLinesOfArtifact({ changedFiles: ['client/client.js'], diffstat: { files: 1, insertions: 900, deletions: 100 } }) === 0, String(productionLinesOfArtifact({ changedFiles: ['client/client.js'], diffstat: { files: 1, insertions: 900, deletions: 100 } })))
  check('an all-production candidate is measured', productionLinesOfArtifact({ changedFiles: ['plugin/a.mjs', 'plugin/b.mjs'], diffstat: { files: 2, insertions: 200, deletions: 60 } }) === 260)
  check('a mixed candidate cannot attribute its lines', productionLinesOfArtifact({ changedFiles: ['plugin/a.mjs', 'client/client.js'], diffstat: { files: 2, insertions: 900, deletions: 100 } }) === null)
  check('an artifact without a diffstat is not judged', productionLinesOfArtifact({ changedFiles: ['plugin/a.mjs'] }) === null)
  const overBudget = validateCardModel({ kind: 'dev', verification: PROBES, changes: [{ path: 'plugin/a.mjs', insertions: 200, deletions: 60 }] })
  check('the model refuses a production change over 250 lines', overBudget.ok === false && overBudget.code === 'too-many-changes', JSON.stringify(overBudget.ok === true ? 'accepted' : overBudget.code))
  const bundleOnly = validateCardModel({ kind: 'dev', verification: PROBES, changes: [{ path: 'client/client.js', insertions: 900, deletions: 100 }] })
  check('the model does not charge the bundle against the line budget', bundleOnly.ok === true && bundleOnly.lines === 0, JSON.stringify(bundleOnly.ok === true ? bundleOnly.lines : bundleOnly.code))
}

// ── submit: the candidate line budget ──────────────────────────────────────
{
  const created = createTask(board(), { title: 'big change', verification: PROBES }, T0, '@lead')
  const claimed = claimTask(created.board, 'T-1', { name: 'worker' }, T0 + 1)
  const big = submitTask(
    claimed.board,
    'T-1',
    { evidence: 'done', merge: { status: 'open', artifact: { hash: 'sha256:big', base: 'base', head: 'head', changedFiles: ['plugin/task-center/service.mjs'], diffstat: { files: 1, insertions: 200, deletions: 60 } } } },
    T0 + 2,
    'worker',
  )
  check('a candidate over the production line budget is refused at submit', big.ok === false && big.code === 'too-many-changes', JSON.stringify(big.ok === true ? big.status : big.code))
  check('the refused submit leaves the card running', big.ok === false && findTask(claimed.board, 'T-1').status === 'running', big.ok === true ? 'moved' : 'unchanged')
  const bundle = submitTask(
    claimed.board,
    'T-1',
    { evidence: 'done', merge: { status: 'open', artifact: { hash: 'sha256:bundle', base: 'base', head: 'head', changedFiles: ['client/client.js'], diffstat: { files: 1, insertions: 900, deletions: 100 } } } },
    T0 + 2,
    'worker',
  )
  check('a bundle-only candidate is not line-budgeted', bundle.ok === true && bundle.task.status === 'reviewing', JSON.stringify(bundle.ok === true ? bundle.task.status : bundle.code))
  const mixed = submitTask(
    claimed.board,
    'T-1',
    { evidence: 'done', merge: { status: 'open', artifact: { hash: 'sha256:mixed', base: 'base', head: 'head', changedFiles: ['plugin/a.mjs', 'client/client.js'], diffstat: { files: 2, insertions: 900, deletions: 100 } } } },
    T0 + 2,
    'worker',
  )
  check('a mixed candidate is not refused on unattributable lines', mixed.ok === true, JSON.stringify(mixed.ok === true ? mixed.task.status : mixed.code))
}

// ── the action surface: the panel/tool path is refused the same way ───────
{
  const rig = createRig({ allowSpawn: false })
  const missing = await rig.action('create', { title: 'from the action' })
  check('the create action refuses a dev card without probes', missing.ok === false && missing.code === 'missing-probes', JSON.stringify(missing.ok === true ? 'created' : missing.code))
  const accepted = await rig.action('create', { title: 'from the action', verification: PROBES, writeFiles: files(5).concat(['client/client.js']) })
  check('the create action accepts a card inside the budget', accepted.ok === true && accepted.task.verification.probes.length === 1, JSON.stringify(accepted.ok === true ? accepted.task.verification : accepted.code))
  const wide = await rig.action('create', { title: 'too wide', verification: PROBES, writeFiles: files(6) })
  check('the create action refuses an over-wide card with a readable code', wide.ok === false && wide.code === 'too-many-files' && typeof wide.message === 'string' && wide.message.indexOf('split the card at design time') >= 0, JSON.stringify(wide.ok === true ? 'created' : wide.code))
  const investigation = await rig.action('create', { title: 'look into it', kind: 'investigate' })
  check('the create action leaves an investigation card alone', investigation.ok === true && investigation.task.kind === 'investigate', JSON.stringify(investigation.ok === true ? investigation.task.kind : investigation.code))
  const cleared = await rig.action('update', { id: accepted.task.id, verification: null })
  check('the update action refuses to clear the probes', cleared.ok === false && cleared.code === 'missing-probes', JSON.stringify(cleared.ok === true ? 'accepted' : cleared.code))
}

// ── a board written BEFORE the rule keeps its cards untouched ────────────
{
  const fs = createFakeFs()
  seedBoard(fs, PROJECT, JSON.stringify({ version: 2, seq: 2, tasks: [{ id: 'T-1', title: 'legacy card', status: 'pending', acceptance: criteria(7) }] }))
  const rig = createRig({ fs, allowSpawn: false })
  const read = await rig.action('get', { id: 'T-1' })
  check('a legacy card still reads', read.ok === true && read.task.verification.probes.length === 0, JSON.stringify(read.ok === true ? read.task.verification : read.code))
  const updated = await rig.action('update', { id: 'T-1', priority: 9 })
  check('a legacy card can still be edited without adopting probes', updated.ok === true && updated.task.verification.probes.length === 0, JSON.stringify(updated.ok === true ? updated.task.verification : updated.code))
  const adopted = await rig.action('update', { id: 'T-1', verification: PROBES })
  check('and it can adopt probes when the update says so', adopted.ok === true && adopted.task.verification.probes.length === 1, JSON.stringify(adopted.ok === true ? adopted.task.verification : adopted.code))
}

console.log(failures === 0 ? '\nPASS  task admin (card model)' : '\nFAIL  ' + String(failures) + ' card-model check(s)')
process.exit(failures === 0 ? 0 : 1)
