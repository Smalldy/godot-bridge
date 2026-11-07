import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMergeJournal } from '../../plugin/task-center/merge-journal.mjs'
import { createMergeReconciler } from '../../plugin/task-center/merge-reconcile.mjs'

const root = mkdtempSync(join(tmpdir(), 'gbt-merge-reconcile-'))
const file = join(root, '.agents', 'merge-journal.json')
const journal = createMergeJournal({ file: file, now: () => 1000 })
let board = {
  tasks: [
    {
      id: 'T-1',
      status: 'testing',
      merge: { status: 'open', base: 'base-1', head: 'head-1' },
      history: [],
      updatedAt: null,
    },
  ],
}
const state = {
  apply: async (project, mutate) => {
    const result = mutate(board)
    if (result.ok === true) {
      board = result.board
      return { failed: null, board: board }
    }
    return { failed: result, board: board }
  },
}
const git = {
  revParse: async () => ({ ok: true, hash: 'merge-1' }),
  isAncestor: async () => ({ ok: true, ancestor: true }),
}
const reconciler = createMergeReconciler({ journalFor: () => journal, git: git, state: state, now: () => 1000 })

try {
  await journal.begin({ id: 'T-1', target: 'main', base: 'base-1', head: 'head-1' })
  const result = await reconciler.reconcileProject('/project')
  assert.equal(result.ok, true)
  assert.equal(result.results[0].action, 'mark-merged')
  assert.equal(result.results[0].ok, true)
  assert.equal(board.tasks[0].status, 'done')
  assert.equal(board.tasks[0].merge.status, 'merged')
  assert.equal(board.tasks[0].merge.mergeCommit, 'merge-1')
  assert.equal((await journal.pending()).entries.length, 0)

  await journal.begin({ id: 'T-2', target: 'main', base: 'base-2', head: 'head-2' })
  const staleGit = {
    revParse: async () => ({ ok: true, hash: 'other-2' }),
    isAncestor: async () => ({ ok: true, ancestor: false }),
  }
  const staleReconciler = createMergeReconciler({ journalFor: () => journal, git: staleGit, state: state, now: () => 1000 })
  const stale = await staleReconciler.reconcileProject('/project')
  assert.equal(stale.ok, true)
  assert.equal(stale.results[0].action, 'mark-stale')
  assert.equal((await journal.status()).counts.stale, 1)

  console.log('PASS  reconcile writes a merged board record and finishes the intent')
  console.log('PASS  reconcile closes a stale intent without touching the board')
} finally {
  rmSync(root, { recursive: true, force: true })
}
