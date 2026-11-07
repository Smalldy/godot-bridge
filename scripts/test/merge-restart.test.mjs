import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMergeJournal } from '../../plugin/task-center/merge-journal.mjs'
import { createMergeReconciler } from '../../plugin/task-center/merge-reconcile.mjs'

const root = mkdtempSync(join(tmpdir(), 'gbt-merge-restart-'))
const file = join(root, '.agents', 'merge-journal.json')
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

try {
  const before = createMergeJournal({ file: file })
  await before.begin({ id: 'T-1', target: 'main', base: 'base-1', head: 'head-1' })

  // Simulate a host restart: a brand-new journal object reads the same file.
  const after = createMergeJournal({ file: file })
  const reconciler = createMergeReconciler({ journalFor: () => after, git: git, state: state, now: () => 1000 })
  const result = await reconciler.reconcileProject('/project')
  assert.equal(result.ok, true)
  assert.equal(result.results[0].action, 'mark-merged')
  assert.equal(board.tasks[0].status, 'done')
  assert.equal(board.tasks[0].merge.status, 'merged')
  assert.equal((await after.pending()).entries.length, 0)

  console.log('PASS  a pending merge intent survives a new journal instance and reconciles the board')
} finally {
  rmSync(root, { recursive: true, force: true })
}
