// File lock tests: canonical paths, segment-aware conflicts, all-or-nothing
// acquisition, release and expiry.

import { join } from 'node:path'
import {
  acquire,
  canonicalList,
  canonicalLockPath,
  conflictsFor,
  emptyLocks,
  expire,
  forceRelease,
  pathsConflict,
  release,
  releaseTask,
  renewTask,
  view,
} from '../../plugin/task-center/locks.mjs'
import { PROJECT } from './support/fixtures.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}
const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const LEASE = 60 * 1000
const thrown = (fn) => {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

// canonicalisation
check('a project-relative path is canonical', canonicalLockPath(PROJECT, 'scripts/core/a.gd') === 'scripts/core/a.gd', canonicalLockPath(PROJECT, 'scripts/core/a.gd'))
check('dot segments are resolved', canonicalLockPath(PROJECT, 'scripts/./core/../core/a.gd') === 'scripts/core/a.gd', canonicalLockPath(PROJECT, 'scripts/./core/../core/a.gd'))
check('an empty path is refused', thrown(() => canonicalLockPath(PROJECT, '  ')) !== null)
check('a parent escape is refused', thrown(() => canonicalLockPath(PROJECT, '../outside.gd')) !== null)
check('an absolute path outside the project is refused', thrown(() => canonicalLockPath(PROJECT, join(PROJECT, '..', 'x.gd'))) !== null)
check('a path inside the project may be absolute', canonicalLockPath(PROJECT, join(PROJECT, 'scripts', 'a.gd')) === 'scripts/a.gd')
check('duplicates are removed', canonicalList(PROJECT, ['scripts/a.gd', 'scripts/a.gd', 'scripts/b.gd']).join(',') === 'scripts/a.gd,scripts/b.gd')

// conflict rules
check('the same path conflicts', pathsConflict('scripts/a.gd', 'scripts/a.gd'))
check('a directory conflicts with its child', pathsConflict('scripts/core', 'scripts/core/a.gd'))
check('a child conflicts with its directory', pathsConflict('scripts/core/a.gd', 'scripts/core'))
check('a similar name is not a child', !pathsConflict('scripts/core', 'scripts/core2/a.gd'))

// acquire / conflicts
{
  let locks = emptyLocks()
  const a = acquire(locks, ['scripts/a.gd', 'scripts/b.gd'], { taskId: 'T-1', agent: '@a' }, T0, LEASE)
  check('a free set is granted', a.ok === true && a.granted === true)
  locks = a.locks
  const b = acquire(locks, ['scripts/b.gd', 'scripts/c.gd'], { taskId: 'T-2', agent: '@b' }, T0, LEASE)
  check('a partial conflict refuses everything', b.ok === true && b.granted === false, JSON.stringify(b))
  check('and names the conflicting path', b.conflicts.length === 1 && b.conflicts[0].path === 'scripts/b.gd', JSON.stringify(b.conflicts))
  check('the refused path was not added', locks['scripts/c.gd'] === undefined)
  const same = acquire(locks, ['scripts/a.gd'], { taskId: 'T-1', agent: '@a' }, T0 + 1000, LEASE)
  check('the same task may re-acquire and renews', same.granted === true && Date.parse(same.locks['scripts/a.gd'].leaseUntil) === T0 + 1000 + LEASE)
  check('conflicts ignore the owner itself', conflictsFor(locks, ['scripts/a.gd'], 'task:T-1').length === 0)
  const dir = acquire(locks, ['scripts'], { taskId: 'T-3', agent: '@c' }, T0, LEASE)
  check('a directory lock conflicts with held children', dir.granted === false && dir.conflicts.length >= 1, JSON.stringify(dir.conflicts))
}

// release / force / expire / renew
{
  let locks = emptyLocks()
  locks = acquire(locks, ['scripts/a.gd', 'scripts/b.gd'], { taskId: 'T-1', agent: '@a' }, T0, LEASE).locks
  locks = acquire(locks, ['scripts/c.gd'], { taskId: 'T-2', agent: '@b' }, T0, LEASE).locks
  const notMine = release(locks, ['scripts/a.gd'], { taskId: 'T-2', agent: '@b' })
  check('a non-owner cannot release', notMine.ok === false && notMine.code === 'not-held')
  const one = release(locks, [], { taskId: 'T-1', agent: '@a' })
  check('an empty path list releases all of the owner locks', one.ok === true && one.released.sort().join(',') === 'scripts/a.gd,scripts/b.gd')
  check('another task retains its lock', one.locks['scripts/c.gd'] !== undefined)
  const forced = forceRelease(locks, ['scripts/c.gd'])
  check('force release frees any owner', forced.ok === true && forced.locks['scripts/c.gd'] === undefined)
  const expiredAt = T0 + LEASE + 1
  const expired = expire(locks, expiredAt)
  check('expiry removes stale locks', expired.ok === true && expired.expired.length === 3, JSON.stringify(expired.expired))
  let renewed = acquire(emptyLocks(), ['scripts/a.gd'], { taskId: 'T-1', agent: '@a' }, T0, LEASE).locks
  const renewal = renewTask(renewed, 'T-1', T0 + 5000, LEASE)
  check('renew extends the lease', renewal.renewed === 1 && Date.parse(renewal.locks['scripts/a.gd'].leaseUntil) === T0 + 5000 + LEASE)
}

// releaseTask releases only that task
{
  let locks = emptyLocks()
  locks = acquire(locks, ['scripts/a.gd'], { taskId: 'T-1', agent: '@a' }, T0, LEASE).locks
  locks = acquire(locks, ['scripts/b.gd'], { taskId: 'T-2', agent: '@b' }, T0, LEASE).locks
  const released = releaseTask(locks, 'T-1')
  check('releaseTask removes its own paths', released.released.join(',') === 'scripts/a.gd')
  check('and leaves the other task alone', released.locks['scripts/b.gd'] !== undefined)
}

// view
{
  let locks = emptyLocks()
  locks = acquire(locks, ['scripts/a.gd'], { taskId: 'T-1', agent: '@a' }, T0, LEASE).locks
  const board = { tasks: [{ id: 'T-1', title: 'Damage' }] }
  const rows = view(locks, board, T0 + 1000)
  check('view names the task', rows.length === 1 && rows[0].taskTitle === 'Damage', JSON.stringify(rows))
  check('view reports the agent', rows[0].agent === '@a')
  check('view flags expiry', view(locks, board, T0 + LEASE + 1)[0].expired === true)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)