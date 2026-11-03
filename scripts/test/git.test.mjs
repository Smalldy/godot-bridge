// Git plumbing tests: the injected-runner contract, the command lines it
// builds, path safety and the parsing of git's output. No real git is started:
// every case injects a fake runner.

import { join, resolve } from 'node:path'
import { DEFAULT_WORKTREE_TIMEOUT_MS, createGit, serialiseWorktreeCreate } from '../../plugin/task-center/git.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}
const isOk = (result) => result !== null && typeof result === 'object' && result.ok === true
const isFailure = (result, code) =>
  result !== null && typeof result === 'object' && result.ok === false && (code === undefined || result.code === code)

const ROOT = join(process.cwd(), 'demo-project')
const INSIDE = join(ROOT, '.worktrees', 'T-1')

/** A recording fake runner: handler(args, cwd) decides each reply. */
function recorder(handler) {
  const calls = []
  const run = (args, cwd, options) => {
    calls.push({ args: args.slice(), cwd: cwd, options: options })
    if (handler === undefined) return { code: 0, stdout: '', stderr: '' }
    return handler(args, cwd, options)
  }
  run.calls = calls
  return run
}

// the module surface
{
  const git = createGit({ run: recorder() })
  const expected = [
    'isRepo',
    'raw',
    'gitPath',
    'checkIgnore',
    'head',
    'currentBranch',
    'isClean',
    'branchExists',
    'revParse',
    'updateRef',
    'worktreeAdd',
    'worktreeRemove',
    'worktreeList',
    'worktreeUnlock',
    'worktreePrune',
    // T-142: the per-worktree cleanup probes.
    'worktreeDirty',
    'worktreeMerged',
    'commitAll',
    'diffNameOnly',
    'mergeNoFf',
    'mergeAbort',
    'mergeFfOnly',
    'resetHard',
    'deleteBranch',
    'conflictedFiles',
    'rebaseOnto',
    // T-100: the ancestor probe behind candidate-stale vs needs-rebase.
    'isAncestor',
  ]
  check(
    'the module exposes every git command the task center needs',
    expected.every((name) => typeof git[name] === 'function') && Object.keys(git).length === expected.length,
    Object.keys(git).join(','),
  )
  check('createGit falls back to a real runner when none is injected', typeof createGit().isRepo === 'function')
}

// isRepo
{
  const run = recorder(() => ({ code: 0, stdout: 'true\n', stderr: '' }))
  const result = await createGit({ run }).isRepo(ROOT)
  check('isRepo reports a work tree', isOk(result) && result.repo === true, JSON.stringify(result))
  check(
    'isRepo asks rev-parse in the root',
    run.calls.length === 1 && run.calls[0].args.join(' ') === 'rev-parse --is-inside-work-tree' && run.calls[0].cwd === ROOT,
    JSON.stringify(run.calls[0]),
  )
  const away = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' })) }).isRepo(ROOT)
  check('isRepo treats a non-repository as false, not a failure', isOk(away) && away.repo === false, JSON.stringify(away))
  const noRoot = await createGit({ run: recorder() }).isRepo('')
  check('an empty root is refused', isFailure(noRoot, 'invalid-root'), JSON.stringify(noRoot))
}

// head
{
  const run = recorder(() => ({ code: 0, stdout: 'abc123\n', stderr: '' }))
  const result = await createGit({ run }).head(ROOT)
  check('head returns the commit hash', isOk(result) && result.hash === 'abc123', JSON.stringify(result))
  const broken = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: ambiguous argument HEAD' })) }).head(ROOT)
  check('head keeps git words in its failure', isFailure(broken, 'rev-parse-failed') && broken.message.indexOf('ambiguous') >= 0, JSON.stringify(broken))
  const empty = await createGit({ run: recorder(() => ({ code: 0, stdout: '\n', stderr: '' })) }).head(ROOT)
  check('head refuses an empty hash', isFailure(empty, 'rev-parse-failed'), JSON.stringify(empty))
}

// currentBranch
{
  const result = await createGit({ run: recorder(() => ({ code: 0, stdout: 'feat/T-1\n', stderr: '' })) }).currentBranch(ROOT)
  check('currentBranch returns the branch name', isOk(result) && result.branch === 'feat/T-1', JSON.stringify(result))
  const detached = await createGit({ run: recorder(() => ({ code: 0, stdout: '\n', stderr: '' })) }).currentBranch(ROOT)
  check('currentBranch is null when HEAD is detached', isOk(detached) && detached.branch === null, JSON.stringify(detached))
  const broken = await createGit({ run: recorder(() => ({ code: 1, stdout: '', stderr: 'nope' })) }).currentBranch(ROOT)
  check('currentBranch reports a failed read', isFailure(broken, 'branch-failed') && broken.message.indexOf('nope') >= 0, JSON.stringify(broken))
}

// isClean
{
  const clean = await createGit({ run: recorder(() => ({ code: 0, stdout: '', stderr: '' })) }).isClean(ROOT)
  check('isClean is true for an empty status', isOk(clean) && clean.clean === true, JSON.stringify(clean))
  const dirty = await createGit({ run: recorder(() => ({ code: 0, stdout: ' M scripts/main.gd\n?? new.gd\n', stderr: '' })) }).isClean(ROOT)
  check('isClean is false with changes', isOk(dirty) && dirty.clean === false, JSON.stringify(dirty))
  const broken = await createGit({ run: recorder(() => ({ code: 1, stdout: '', stderr: 'bad' })) }).isClean(ROOT)
  check('isClean reports a failed status', isFailure(broken, 'status-failed'), JSON.stringify(broken))
}

// branchExists
{
  const yes = await createGit({ run: recorder(() => ({ code: 0, stdout: 'abc\n', stderr: '' })) }).branchExists(ROOT, 'feat')
  check('branchExists finds a local branch', isOk(yes) && yes.exists === true, JSON.stringify(yes))
  const no = await createGit({ run: recorder(() => ({ code: 1, stdout: '', stderr: '' })) }).branchExists(ROOT, 'missing')
  check('branchExists is false for a missing branch', isOk(no) && no.exists === false, JSON.stringify(no))
  const asked = recorder(() => ({ code: 0, stdout: '', stderr: '' }))
  await createGit({ run: asked }).branchExists(ROOT, 'feat')
  check('branchExists looks under refs/heads', asked.calls[0].args.join(' ') === 'rev-parse --verify --quiet refs/heads/feat', JSON.stringify(asked.calls[0].args))
  const bad = await createGit({ run: recorder() }).branchExists(ROOT, '-x')
  check('branchExists refuses an option-shaped name', isFailure(bad, 'invalid-branch'), JSON.stringify(bad))
}

// revParse
{
  const run = recorder(() => ({ code: 0, stdout: 'deadbeef\n', stderr: '' }))
  const good = await createGit({ run }).revParse(ROOT, 'main')
  check('revParse resolves a ref', isOk(good) && good.hash === 'deadbeef', JSON.stringify(good))
  check('revParse asks git to verify the ref', run.calls[0].args.join(' ') === 'rev-parse --verify main', JSON.stringify(run.calls[0].args))
  const missing = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: Needed a single revision' })) }).revParse(ROOT, 'nope')
  check('revParse reports an unknown ref', isFailure(missing, 'unknown-ref'), JSON.stringify(missing))
  const bad = await createGit({ run: recorder() }).revParse(ROOT, '')
  check('revParse refuses an empty ref', isFailure(bad, 'invalid-ref'), JSON.stringify(bad))
}

// worktreeAdd — its own budget (T-43)
//
// Creating a checkout is the one call that legitimately runs for minutes, so it
// must ask the runner for a wider budget than a read. A generic 60 s runner
// timeout once killed an add half-way and left a registered, locked worktree.
{
  const run = recorder(() => ({ code: 0, stdout: "", stderr: "" }))
  await createGit({ run }).worktreeAdd(ROOT, { path: '.worktrees/T-1', branch: 'feat/T-1', base: 'main' })
  const add = run.calls[0]
  check('a worktree add asks the runner for its own wide budget', add.options !== undefined && add.options.op === 'worktree-add' && add.options.timeoutMs === DEFAULT_WORKTREE_TIMEOUT_MS, JSON.stringify(add.options))
  check('and the default budget is minutes, not the 60 s read budget', DEFAULT_WORKTREE_TIMEOUT_MS >= 120 * 1000, String(DEFAULT_WORKTREE_TIMEOUT_MS))

  const read = recorder(() => ({ code: 0, stdout: "abc", stderr: "" }))
  const reader = createGit({ run: read })
  await reader.head(ROOT)
  check('an ordinary read does not ask for a budget', read.calls[0].options === undefined, JSON.stringify(read.calls[0].options))

  const custom = recorder(() => ({ code: 0, stdout: "", stderr: "" }))
  await createGit({ run: custom, worktreeTimeoutMs: 9 * 1000 }).worktreeAdd(ROOT, { path: '.worktrees/T-1', branch: 'feat/T-1' })
  check('createGit accepts a configured worktree budget', custom.calls[0].options.timeoutMs === 9 * 1000, JSON.stringify(custom.calls[0].options))
  await createGit({ run: custom }).worktreeAdd(ROOT, { path: '.worktrees/T-2', branch: 'feat/T-2', timeoutMs: 5 * 1000 })
  check('and a per-call override wins', custom.calls[1].options.timeoutMs === 5 * 1000, JSON.stringify(custom.calls[1].options))
}

// worktreeUnlock / worktreePrune — the rollback primitives (T-43)
{
  const unlockRun = recorder(() => ({ code: 0, stdout: "", stderr: "" }))
  const unlocked = await createGit({ run: unlockRun }).worktreeUnlock(ROOT, '.worktrees/T-1')
  check('unlock runs git worktree unlock on the checkout', isOk(unlocked) && unlocked.unlocked === true && unlockRun.calls[0].args.join(' ') === 'worktree unlock ' + INSIDE, JSON.stringify(unlockRun.calls[0] && unlockRun.calls[0].args))

  const notLocked = createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: not locked' })) })
  const idle = await notLocked.worktreeUnlock(ROOT, '.worktrees/T-1')
  check('unlocking an unlocked checkout is not an error for a rollback', isOk(idle) && idle.unlocked === false, JSON.stringify(idle))

  const pruneRun = recorder(() => ({ code: 0, stdout: 'Removing worktrees/T-1: gitdir file points to non-existent location\n', stderr: '' }))
  const pruned = await createGit({ run: pruneRun }).worktreePrune(ROOT)
  check('prune drops stale administrative entries', isOk(pruned) && pruned.pruned.length === 1 && pruneRun.calls[0].args.join(' ') === 'worktree prune -v', JSON.stringify(pruned))
}

// worktreeAdd
{
  const run = recorder(() => ({ code: 0, stdout: 'Preparing worktree\n', stderr: '' }))
  const result = await createGit({ run }).worktreeAdd(ROOT, { path: '.worktrees/T-1', branch: 'feat/T-1', base: 'main' })
  check(
    'worktreeAdd returns the absolute path, branch and base',
    isOk(result) && result.path === INSIDE && result.branch === 'feat/T-1' && result.base === 'main',
    JSON.stringify(result),
  )
  check(
    'worktreeAdd creates the branch from the base',
    run.calls[0].args.join(' ') === ['worktree', 'add', '-b', 'feat/T-1', INSIDE, 'main'].join(' ') && run.calls[0].cwd === ROOT,
    JSON.stringify(run.calls[0]),
  )
  const fromHead = recorder(() => ({ code: 0, stdout: '', stderr: '' }))
  const branchOnly = await createGit({ run: fromHead }).worktreeAdd(ROOT, { path: '.worktrees/T-2', branch: 'feat/T-2' })
  check(
    'worktreeAdd without a base branches from HEAD',
    isOk(branchOnly) && branchOnly.base === null && fromHead.calls[0].args.join(' ') === ['worktree', 'add', '-b', 'feat/T-2', join(ROOT, '.worktrees', 'T-2')].join(' '),
    JSON.stringify(fromHead.calls[0].args),
  )
  const refused = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: "fatal: a branch named 'feat' already exists" })) }).worktreeAdd(ROOT, { path: '.worktrees/T-1', branch: 'feat' })
  check(
    'worktreeAdd reports a refused add',
    isFailure(refused, 'worktree-add-failed') && refused.message.indexOf('already exists') >= 0,
    JSON.stringify(refused),
  )
  const escape = recorder()
  const outside = await createGit({ run: escape }).worktreeAdd(ROOT, { path: '../outside', branch: 'feat' })
  check('worktreeAdd refuses a path outside the root', isFailure(outside, 'outside-root'), JSON.stringify(outside))
  check('an escaping path never reaches git', escape.calls.length === 0, String(escape.calls.length))
  const absoluteOutside = await createGit({ run: recorder() }).worktreeAdd(ROOT, { path: join(ROOT, '..', 'x'), branch: 'feat' })
  check('worktreeAdd refuses an absolute path outside the root', isFailure(absoluteOutside, 'outside-root'), JSON.stringify(absoluteOutside))
  const empty = await createGit({ run: recorder() }).worktreeAdd(ROOT, { path: '', branch: 'feat' })
  check('worktreeAdd refuses an empty path', isFailure(empty, 'invalid-path'), JSON.stringify(empty))
  const rootItself = await createGit({ run: recorder() }).worktreeAdd(ROOT, { path: ROOT, branch: 'feat' })
  check('worktreeAdd refuses the root itself', isFailure(rootItself, 'outside-root'), JSON.stringify(rootItself))
  const noBranch = await createGit({ run: recorder() }).worktreeAdd(ROOT, { path: '.worktrees/T-1', branch: '   ' })
  check('worktreeAdd refuses an empty branch', isFailure(noBranch, 'invalid-branch'), JSON.stringify(noBranch))

  // T-131: an investigation scratch is DETACHED — no branch is created at all.
  const detachRun = recorder(() => ({ code: 0, stdout: '', stderr: '' }))
  const detached = await createGit({ run: detachRun }).worktreeAdd(ROOT, { path: '.worktrees/T-9', base: 'main', detach: true })
  check(
    'worktreeAdd detach returns a branchless checkout',
    isOk(detached) && detached.branch === null && detached.detached === true && detached.path === join(ROOT, '.worktrees', 'T-9'),
    JSON.stringify(detached),
  )
  check(
    'worktreeAdd detach passes --detach instead of -b',
    detachRun.calls[0].args.join(' ') === ['worktree', 'add', '--detach', join(ROOT, '.worktrees', 'T-9'), 'main'].join(' '),
    JSON.stringify(detachRun.calls[0].args),
  )
  const detachNoBase = await createGit({ run: recorder(() => ({ code: 0, stdout: '', stderr: '' })) }).worktreeAdd(ROOT, { path: '.worktrees/T-10', detach: true })
  check('worktreeAdd detach without a base detaches at HEAD', isOk(detachNoBase) && detachNoBase.base === null && detachNoBase.branch === null, JSON.stringify(detachNoBase))
  const detachRefused = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: already exists' })) }).worktreeAdd(ROOT, { path: '.worktrees/T-11', detach: true })
  check('worktreeAdd detach reports a refused add', isFailure(detachRefused, 'worktree-add-failed'), JSON.stringify(detachRefused))
  const detachOutside = await createGit({ run: recorder() }).worktreeAdd(ROOT, { path: '../outside', detach: true })
  check('worktreeAdd detach still refuses a path outside the root', isFailure(detachOutside, 'outside-root'), JSON.stringify(detachOutside))
}

// worktreeRemove
{
  const run = recorder(() => ({ code: 0, stdout: '', stderr: '' }))
  const result = await createGit({ run }).worktreeRemove(ROOT, '.worktrees/T-1')
  check('worktreeRemove returns the removed path', isOk(result) && result.path === INSIDE && result.force === false, JSON.stringify(result))
  check('worktreeRemove removes without force', run.calls[0].args.join(' ') === ['worktree', 'remove', INSIDE].join(' '), JSON.stringify(run.calls[0].args))
  const forced = recorder(() => ({ code: 0, stdout: '', stderr: '' }))
  await createGit({ run: forced }).worktreeRemove(ROOT, '.worktrees/T-1', { force: true })
  check('worktreeRemove passes --force', forced.calls[0].args.join(' ') === ['worktree', 'remove', '--force', INSIDE].join(' '), JSON.stringify(forced.calls[0].args))
  const refused = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: contains modified or untracked files' })) }).worktreeRemove(ROOT, '.worktrees/T-1')
  check('worktreeRemove reports a refused removal', isFailure(refused, 'worktree-remove-failed'), JSON.stringify(refused))
  const outside = await createGit({ run: recorder() }).worktreeRemove(ROOT, '../elsewhere')
  check('worktreeRemove refuses a path outside the root', isFailure(outside, 'outside-root'), JSON.stringify(outside))
}

// worktreeList
{
  const sha = '1'.repeat(40)
  const second = '2'.repeat(40)
  const porcelain = [
    'worktree ' + ROOT,
    'HEAD ' + sha,
    'branch refs/heads/main',
    '',
    'worktree ' + INSIDE,
    'HEAD ' + second,
    'detached',
    '',
  ].join('\n')
  const run = recorder(() => ({ code: 0, stdout: porcelain, stderr: '' }))
  const result = await createGit({ run }).worktreeList(ROOT)
  check('worktreeList parses both worktrees', isOk(result) && result.worktrees.length === 2, JSON.stringify(result))
  check(
    'worktreeList keeps the main worktree branch',
    isOk(result) && result.worktrees[0].path === ROOT && result.worktrees[0].head === sha && result.worktrees[0].branch === 'main',
    JSON.stringify(isOk(result) ? result.worktrees[0] : result),
  )
  check(
    'worktreeList reports a detached worktree as no branch',
    isOk(result) && result.worktrees[1].path === INSIDE && result.worktrees[1].head === second && result.worktrees[1].branch === null,
    JSON.stringify(isOk(result) ? result.worktrees[1] : result),
  )
  const failedList = await createGit({ run: recorder(() => ({ code: 1, stdout: '', stderr: 'fatal' })) }).worktreeList(ROOT)
  check('worktreeList reports a failed listing', isFailure(failedList, 'worktree-list-failed'), JSON.stringify(failedList))
}

// worktreeDirty / worktreeMerged — the cleanup probes (T-142)
{
  const cleanRun = recorder(() => ({ code: 0, stdout: '', stderr: '' }))
  const clean = await createGit({ run: cleanRun }).worktreeDirty(ROOT, INSIDE)
  check(
    'worktreeDirty reports a clean checkout',
    isOk(clean) && clean.dirty === false && clean.path === INSIDE,
    JSON.stringify(clean),
  )
  check(
    'worktreeDirty runs git status INSIDE the worktree',
    cleanRun.calls.length === 1 && cleanRun.calls[0].args.join(' ') === 'status --porcelain' && cleanRun.calls[0].cwd === INSIDE,
    JSON.stringify(cleanRun.calls[0]),
  )
  const dirty = await createGit({ run: recorder(() => ({ code: 0, stdout: ' M scripts/a.gd\n?? notes.txt\n', stderr: '' })) }).worktreeDirty(ROOT, INSIDE)
  check('worktreeDirty reports a dirty checkout', isOk(dirty) && dirty.dirty === true, JSON.stringify(dirty))
  const statusFailed = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal' })) }).worktreeDirty(ROOT, INSIDE)
  check('worktreeDirty reports a failed status', isFailure(statusFailed, 'worktree-status-failed'), JSON.stringify(statusFailed))
  const escaping = await createGit({ run: recorder() }).worktreeDirty(ROOT, '../elsewhere')
  check('worktreeDirty refuses a path outside the root', isFailure(escaping, 'outside-root'), JSON.stringify(escaping))

  const mergedRun = recorder(() => ({ code: 0, stdout: '', stderr: '' }))
  const merged = await createGit({ run: mergedRun }).worktreeMerged(ROOT, INSIDE, 'feat/task-center-v2')
  check('worktreeMerged reports an already-merged HEAD', isOk(merged) && merged.merged === true, JSON.stringify(merged))
  check(
    'worktreeMerged asks merge-base --is-ancestor HEAD <target> in the worktree',
    mergedRun.calls.length === 1 && mergedRun.calls[0].args.join(' ') === 'merge-base --is-ancestor HEAD feat/task-center-v2' && mergedRun.calls[0].cwd === INSIDE,
    JSON.stringify(mergedRun.calls[0]),
  )
  const unmerged = await createGit({ run: recorder(() => ({ code: 1, stdout: '', stderr: '' })) }).worktreeMerged(ROOT, INSIDE, 'feat/task-center-v2')
  check('exit 1 is "not merged yet", not an error', isOk(unmerged) && unmerged.merged === false, JSON.stringify(unmerged))
  const mergeFailed = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal' })) }).worktreeMerged(ROOT, INSIDE, 'feat/task-center-v2')
  check('worktreeMerged reports a failed probe', isFailure(mergeFailed, 'worktree-merge-check-failed'), JSON.stringify(mergeFailed))
  const badTarget = await createGit({ run: recorder() }).worktreeMerged(ROOT, INSIDE, '')
  check('worktreeMerged refuses an empty target ref', isFailure(badTarget, 'invalid-ref'), JSON.stringify(badTarget))
}

// commitAll
{
  const replies = [
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '[main abc1234] work: T-1\n 1 file changed', stderr: '' },
    { code: 0, stdout: 'abc1234\n', stderr: '' },
  ]
  const run = recorder(() => replies.shift())
  const result = await createGit({ run }).commitAll(ROOT, 'work: T-1')
  check('commitAll returns the new commit hash', isOk(result) && result.hash === 'abc1234', JSON.stringify(result))
  check(
    'commitAll stages everything, commits, then reads HEAD',
    run.calls.map((call) => call.args.join(' ')).join(' | ') === 'add -A | commit -m work: T-1 | rev-parse HEAD',
    JSON.stringify(run.calls.map((call) => call.args)),
  )
  check('every commitAll call runs in the root', run.calls.every((call) => call.cwd === ROOT))
  const nothing = await createGit({ run: recorder((args) => (args[0] === 'add' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: 'nothing to commit, working tree clean', stderr: '' })) }).commitAll(ROOT, 'empty')
  check('commitAll reports nothing-to-commit', isFailure(nothing, 'nothing-to-commit'), JSON.stringify(nothing))
  const addFailed = await createGit({ run: recorder(() => ({ code: 1, stdout: '', stderr: 'fatal: index.lock exists' })) }).commitAll(ROOT, 'x')
  check('commitAll reports a failed add', isFailure(addFailed, 'add-failed'), JSON.stringify(addFailed))
  const noMessage = await createGit({ run: recorder() }).commitAll(ROOT, '   ')
  check('commitAll refuses an empty message', isFailure(noMessage, 'invalid-message'), JSON.stringify(noMessage))
}

// diffNameOnly
{
  const run = recorder(() => ({ code: 0, stdout: 'scripts/a.gd\nscripts/b.gd\n\n', stderr: '' }))
  const result = await createGit({ run }).diffNameOnly(ROOT, 'main', 'feat/T-1')
  check('diffNameOnly lists one entry per changed file', isOk(result) && result.files.join(',') === 'scripts/a.gd,scripts/b.gd', JSON.stringify(result))
  check('diffNameOnly diffs the base against the head', run.calls[0].args.join(' ') === 'diff --name-only main feat/T-1', JSON.stringify(run.calls[0].args))
  const empty = await createGit({ run: recorder(() => ({ code: 0, stdout: '', stderr: '' })) }).diffNameOnly(ROOT, 'main', 'feat/T-1')
  check('diffNameOnly returns no files for an empty diff', isOk(empty) && empty.files.length === 0, JSON.stringify(empty))
  const failedDiff = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: bad revision' })) }).diffNameOnly(ROOT, 'main', 'nope')
  check(
    'diffNameOnly reports a failed diff',
    isFailure(failedDiff, 'diff-failed') && failedDiff.message.indexOf('bad revision') >= 0,
    JSON.stringify(failedDiff),
  )
  const emptyRef = await createGit({ run: recorder() }).diffNameOnly(ROOT, '', 'main')
  check('diffNameOnly refuses an empty base', isFailure(emptyRef, 'invalid-ref'), JSON.stringify(emptyRef))
}

// mergeNoFf
{
  const run = recorder(() => ({ code: 0, stdout: 'Merge made by the ort strategy.\n', stderr: '' }))
  const result = await createGit({ run }).mergeNoFf(ROOT, ROOT, 'feat/T-1')
  check(
    'mergeNoFf merges the branch into the target checkout',
    isOk(result) && result.branch === 'feat/T-1' && result.target === ROOT,
    JSON.stringify(result),
  )
  check(
    'mergeNoFf uses --no-ff and a generated message',
    run.calls[0].args.join(' ') === 'merge --no-ff --no-edit feat/T-1' && run.calls[0].cwd === ROOT,
    JSON.stringify(run.calls[0]),
  )
  const worktreeRun = recorder(() => ({ code: 0, stdout: '', stderr: '' }))
  const inWorktree = await createGit({ run: worktreeRun }).mergeNoFf(ROOT, '.worktrees/T-1', 'feat/T-1')
  check('mergeNoFf can merge inside a worktree under the root', isOk(inWorktree) && worktreeRun.calls[0].cwd === INSIDE, JSON.stringify(worktreeRun.calls[0]))
  const conflict = await createGit({
    run: recorder(() => ({
      code: 1,
      stdout: 'CONFLICT (content): Merge conflict in scripts/a.gd\nAutomatic merge failed; fix conflicts and then commit the result.',
      stderr: '',
    })),
  }).mergeNoFf(ROOT, ROOT, 'feat/T-1')
  check('mergeNoFf reports a conflict', isFailure(conflict, 'merge-conflict'), JSON.stringify(conflict))
  const other = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: not something we can merge' })) }).mergeNoFf(ROOT, ROOT, 'nope')
  check('mergeNoFf reports any other merge failure', isFailure(other, 'merge-failed'), JSON.stringify(other))
  const outside = await createGit({ run: recorder() }).mergeNoFf(ROOT, '../elsewhere', 'feat')
  check('mergeNoFf refuses a checkout outside the root', isFailure(outside, 'outside-root'), JSON.stringify(outside))
}

// mergeAbort
{
  const run = recorder(() => ({ code: 0, stdout: '', stderr: '' }))
  const result = await createGit({ run }).mergeAbort(ROOT)
  check('mergeAbort aborts the merge in the root', isOk(result) && result.aborted === true && run.calls[0].args.join(' ') === 'merge --abort', JSON.stringify(result))
  const failedAbort = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: There is no merge to abort' })) }).mergeAbort(ROOT)
  check('mergeAbort reports a failed abort', isFailure(failedAbort, 'merge-abort-failed'), JSON.stringify(failedAbort))
}

// rebaseOnto
{
  const run = recorder(() => ({ code: 0, stdout: 'Successfully rebased and updated HEAD\n', stderr: '' }))
  const result = await createGit({ run }).rebaseOnto(ROOT, 'main')
  check('rebaseOnto rebases onto the target', isOk(result) && result.onto === 'main' && run.calls[0].args.join(' ') === 'rebase main', JSON.stringify(result))
  const conflict = await createGit({
    run: recorder(() => ({ code: 1, stdout: 'CONFLICT (content): Merge conflict in scripts/a.gd\nResolve all conflicts manually', stderr: '' })),
  }).rebaseOnto(ROOT, 'main')
  check('rebaseOnto reports a conflict', isFailure(conflict, 'rebase-conflict'), JSON.stringify(conflict))
  const other = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: invalid upstream' })) }).rebaseOnto(ROOT, 'nope')
  check('rebaseOnto reports any other rebase failure', isFailure(other, 'rebase-failed'), JSON.stringify(other))
}

// mergeFfOnly
{
  const run = recorder(() => ({ code: 0, stdout: 'Updating abc..def\nFast-forward\n', stderr: '' }))
  const result = await createGit({ run }).mergeFfOnly(ROOT, 'merge/T-1')
  check(
    'mergeFfOnly fast-forwards the main checkout',
    isOk(result) && result.branch === 'merge/T-1' && run.calls[0].args.join(' ') === 'merge --ff-only merge/T-1' && run.calls[0].cwd === ROOT,
    JSON.stringify(run.calls[0]),
  )
  const refused = await createGit({
    run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' })),
  }).mergeFfOnly(ROOT, 'merge/T-1')
  check('mergeFfOnly reports a refused fast-forward', isFailure(refused, 'merge-fast-forward-failed') && refused.message.indexOf('Not possible') >= 0, JSON.stringify(refused))
  const option = await createGit({ run: recorder() }).mergeFfOnly(ROOT, '--force')
  check('mergeFfOnly refuses an option-shaped branch', isFailure(option, 'invalid-branch'), JSON.stringify(option))
}

// resetHard
{
  const run = recorder(() => ({ code: 0, stdout: 'HEAD is now at abc\n', stderr: '' }))
  const result = await createGit({ run }).resetHard(INSIDE)
  check(
    'resetHard resets a throwaway checkout',
    isOk(result) && result.reset === true && run.calls[0].args.join(' ') === 'reset --hard HEAD' && run.calls[0].cwd === INSIDE,
    JSON.stringify(run.calls[0]),
  )
  const refused = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: bad revision' })) }).resetHard(INSIDE)
  check('resetHard reports a failed reset', isFailure(refused, 'reset-failed'), JSON.stringify(refused))
}

// deleteBranch
{
  const run = recorder(() => ({ code: 0, stdout: 'Deleted branch merge/T-1\n', stderr: '' }))
  const result = await createGit({ run }).deleteBranch(ROOT, 'merge/T-1')
  check(
    'deleteBranch uses -d by default',
    isOk(result) && result.force === false && run.calls[0].args.join(' ') === 'branch -d merge/T-1' && run.calls[0].cwd === ROOT,
    JSON.stringify(run.calls[0]),
  )
  const forced = recorder(() => ({ code: 0, stdout: '', stderr: '' }))
  const forcedResult = await createGit({ run: forced }).deleteBranch(ROOT, 'merge/T-1', { force: true })
  check(
    'deleteBranch can force-delete a throwaway branch',
    isOk(forcedResult) && forcedResult.force === true && forced.calls[0].args.join(' ') === 'branch -D merge/T-1',
    JSON.stringify(forced.calls[0]),
  )
  const refused = await createGit({
    run: recorder(() => ({ code: 1, stdout: '', stderr: "error: the branch 'merge/T-1' is not fully merged" })),
  }).deleteBranch(ROOT, 'merge/T-1')
  check('deleteBranch reports an unmerged branch', isFailure(refused, 'branch-delete-failed'), JSON.stringify(refused))
  const option = await createGit({ run: recorder() }).deleteBranch(ROOT, '-D')
  check('deleteBranch refuses an option-shaped name', isFailure(option, 'invalid-branch'), JSON.stringify(option))
}

// conflictedFiles
{
  const run = recorder(() => ({ code: 0, stdout: 'scripts/a.gd\nscripts/b.gd\n', stderr: '' }))
  const result = await createGit({ run }).conflictedFiles(INSIDE)
  check(
    'conflictedFiles lists unmerged paths',
    isOk(result) && result.files.join(',') === 'scripts/a.gd,scripts/b.gd' && run.calls[0].args.join(' ') === 'diff --name-only --diff-filter=U' && run.calls[0].cwd === INSIDE,
    JSON.stringify(run.calls[0]),
  )
  const refused = await createGit({ run: recorder(() => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' })) }).conflictedFiles(INSIDE)
  check('conflictedFiles reports a failed listing', isFailure(refused, 'conflict-list-failed'), JSON.stringify(refused))
}

// a runner that misbehaves is a failure, never an exception
{
  const thrown = await createGit({
    run: () => {
      throw new Error('spawn git ENOENT')
    },
  }).head(ROOT)
  check('a runner that throws becomes a failure', isFailure(thrown, 'rev-parse-failed') && thrown.message.indexOf('spawn git ENOENT') >= 0, JSON.stringify(thrown))
  const emptyAnswer = await createGit({ run: () => null }).head(ROOT)
  check('a runner that answers nothing becomes a failure', isFailure(emptyAnswer, 'rev-parse-failed'), JSON.stringify(emptyAnswer))
  const throwingCreate = await createGit({
    run: () => {
      throw new Error('boom')
    },
  }).worktreeAdd(ROOT, { path: '../escape', branch: 'feat' })
  check('a refused path is still refused before the runner is consulted', isFailure(throwingCreate, 'outside-root'), JSON.stringify(throwingCreate))
}

// ── the shared worktree-create gate ────────────────────────────────────────
{
  const order = []
  let active = 0
  let overlapped = false
  const first = serialiseWorktreeCreate(ROOT, async () => {
    active++
    if (active > 1) overlapped = true
    order.push('first-start')
    await new Promise((resolve) => setTimeout(resolve, 40))
    order.push('first-end')
    active--
    return 'first'
  })
  const second = serialiseWorktreeCreate(ROOT, async () => {
    active++
    if (active > 1) overlapped = true
    order.push('second-start')
    active--
    return 'second'
  })
  const results = await Promise.all([first, second])
  check('the shared gate runs worktree creations one at a time', overlapped === false && order.join(',') === 'first-start,first-end,second-start', JSON.stringify(order))
  check('the gate returns each unit\'s own result', results[0] === 'first' && results[1] === 'second', JSON.stringify(results))
  let ran = false
  await serialiseWorktreeCreate(ROOT, async () => { throw new Error('boom') }).catch(() => {})
  await serialiseWorktreeCreate(ROOT, async () => { ran = true })
  check('a failed unit does not poison the chain', ran === true)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
