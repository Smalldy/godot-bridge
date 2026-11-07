import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDoneAllDrawer } = require('../../client/src/views/done-all-drawer.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const doneAllState = {
  items: [{ id: 'T-9', title: 'Done card', updatedAt: '2026-11-08T00:00:00Z' }],
  next: null,
  loading: false,
  error: false,
  failedMore: false,
  query: '',
  loadedQuery: '',
  token: 0,
  busy: false,
}
const DoneAllDrawer = createDoneAllDrawer({
  React: { useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {} },
  h: h,
  doneAllState: doneAllState,
  tcDayKey: () => 'today',
})
const out = DoneAllDrawer({
  t: (key) => key,
  store: { listTasks: async () => ({ ok: true, tasks: [], nextCursor: null }) },
  archived: false,
  onClose: () => {},
})
assert.equal(out.type, 'div')
assert.equal(out.props['data-done-all-overlay'], 'true')
const text = JSON.stringify(out)
assert.ok(text.includes('T-9'))
assert.ok(text.includes('doneAllToday'))

console.log('PASS  DoneAllDrawer is an independently testable view module')
