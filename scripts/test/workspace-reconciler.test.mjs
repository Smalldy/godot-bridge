import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceReconciler } from '../../plugin/task-center/workspace.mjs'

const STALE = 5 * 60 * 1000

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbt-workspace-'))
  const gitDir = join(root, '.git')
  mkdirSync(gitDir)
  const git = { gitPath: async (project, name) => ({ ok: true, path: join(gitDir, name) }) }
  return { root, gitDir, git }
}

function oldLock(gitDir) {
  const path = join(gitDir, 'index.lock')
  writeFileSync(path, '')
  const old = new Date(Date.now() - 10 * 60 * 1000)
  utimesSync(path, old, old)
  return path
}

try {
  const stale = fixture()
  const lock = oldLock(stale.gitDir)
  const reconciler = createWorkspaceReconciler({ git: stale.git, staleLockMs: STALE, processChecker: async () => false })
  const plan = await reconciler.plan(stale.root)
  assert.equal(plan.action, 'remove-stale-index-lock')
  assert.equal(plan.lock.suspectedStale, true)
  assert.equal(plan.process.running, false)
  const applied = await reconciler.apply(plan)
  assert.equal(applied.ok, true)
  assert.equal(applied.action, 'renamed')
  assert.equal(readdirSync(stale.gitDir).some((name) => name.startsWith('index.lock.stale-')), true)
  assert.equal(readdirSync(stale.gitDir).includes('index.lock'), false)
  rmSync(stale.root, { recursive: true, force: true })

  const held = fixture()
  oldLock(held.gitDir)
  const heldReconciler = createWorkspaceReconciler({ git: held.git, staleLockMs: STALE, processChecker: async () => true })
  const heldPlan = await heldReconciler.plan(held.root)
  assert.equal(heldPlan.action, 'manual-check')
  const heldApply = await heldReconciler.apply(heldPlan)
  assert.equal(heldApply.ok, false)
  assert.equal(heldApply.code, 'not-recoverable')
  rmSync(held.root, { recursive: true, force: true })

  const fresh = fixture()
  writeFileSync(join(fresh.gitDir, 'index.lock'), '')
  const freshReconciler = createWorkspaceReconciler({ git: fresh.git, staleLockMs: STALE, processChecker: async () => false })
  const freshPlan = await freshReconciler.plan(fresh.root)
  assert.equal(freshPlan.action, 'inspect')
  rmSync(fresh.root, { recursive: true, force: true })

  const merging = fixture()
  oldLock(merging.gitDir)
  writeFileSync(join(merging.gitDir, 'MERGE_HEAD'), 'abc')
  const mergeReconciler = createWorkspaceReconciler({ git: merging.git, staleLockMs: STALE, processChecker: async () => false })
  const mergePlan = await mergeReconciler.plan(merging.root)
  assert.equal(mergePlan.action, 'blocked')
  assert.equal(mergePlan.merge.inProgress, true)
  rmSync(merging.root, { recursive: true, force: true })

  const clean = fixture()
  const cleanReconciler = createWorkspaceReconciler({ git: clean.git, staleLockMs: STALE, processChecker: async () => false })
  const cleanPlan = await cleanReconciler.plan(clean.root)
  assert.equal(cleanPlan.action, 'none')
  const cleanApply = await cleanReconciler.apply(cleanPlan)
  assert.equal(cleanApply.ok, true)
  assert.equal(cleanApply.action, 'none')
  rmSync(clean.root, { recursive: true, force: true })

  console.log('PASS  stale lock plans a rename, not a delete')
  console.log('PASS  a held/fresh/merging lock is never auto-recovered')
  console.log('PASS  no lock is a no-op')
} finally {
  // Each fixture cleans itself; this is only a guard for an assertion failure.
}
