/**
 * T-242: load the REAL browser snapshot projection.
 *
 * The panel's snapshot is not the raw /state answer: the store composes the views
 * over tcSnapshot()/tcMergeSnapshot() from client/src/15-client-state.part (the
 * same declarations the shipped bundle inlines). A test that hand-builds a
 * snapshot cannot see a field the projection DROPS — review round 1 found exactly
 * that: /state carried archiveSettings/archivedIndexCount, the projection dropped
 * them, and the settings page silently rendered defaults.
 *
 * This helper extracts the two declarations from the part and evaluates them, so
 * a store/view test can drive the real builder instead of a fabricated one.
 */
import { readFileSync } from 'node:fs'

const PART_URL = new URL('../../../client/src/15-client-state.part', import.meta.url)

export function loadClientStateProjection() {
  const source = readFileSync(PART_URL, 'utf8')
  const start = source.indexOf('function tcSnapshot(')
  const end = source.indexOf('function tcErrorMessage(')
  if (start < 0 || end <= start) {
    throw new Error('client/src/15-client-state.part no longer declares tcSnapshot/tcMergeSnapshot before tcErrorMessage')
  }
  const body = source.slice(start, end) + '\nreturn { tcSnapshot: tcSnapshot, tcMergeSnapshot: tcMergeSnapshot }'
  return new Function(body)()
}
