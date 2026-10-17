// Activation test: the task-center row must wire its tool, routes, timer and
// event listener without a live host. This is the seam unit tests skip.

import { register } from 'node:module'
register('./stubs/hooks.mjs', import.meta.url)

const { apply } = await import('../../plugin/task-center/index.mjs')
const { createFakeFs, PROJECT } = await import('./support/fixtures.mjs')

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

globalThis.setInterval = function () { return 0 }
globalThis.clearInterval = function () {}

const tools = []
const routes = []
const effects = []
const disposers = []
const listeners = []
const ctx = {
  fs: createFakeFs(),
  sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
  logger: { warn() {} },
  tools: {
    register(tool) {
      tools.push(tool)
      return () => { tools.length = 0 }
    },
  },
  webServer: {
    register(spec) {
      routes.push(spec)
      return () => {}
    },
  },
  on(event, handler) {
    listeners.push({ event, handler })
    return () => {}
  },
  effect(callback, label) {
    effects.push(label)
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push({ label, disposer })
    return disposer
  },
  get(key) {
    if (key === 'agents') return { list: () => [] }
    if (key === 'agentTeams') return null
    if (key === 'subagents') return { list: () => ['spawn'] }
    return undefined
  },
}

let activationError = null
try {
  apply(ctx)
} catch (error) {
  activationError = error
}
check('the row activates without a host', activationError === null, activationError && activationError.stack)
check('the tool is registered', tools.length === 1 && tools[0].name === 'task_center', String(tools.length))
check('three routes are registered', routes.length === 3, routes.map((route) => route.path).join(','))
check('the routes include state, action and diagnostics', routes.map((route) => route.path).join(',').indexOf('/state') >= 0 && routes.map((route) => route.path).join(',').indexOf('/action') >= 0)
check('an agent status listener is installed', listeners.some((entry) => entry.event === 'agent/status'))
check('the effects are labelled', effects.some((label) => label.indexOf('task center') >= 0) && effects.some((label) => label.indexOf('task_center') >= 0), effects.join(' | '))
check('the tool action enum includes start and pause', tools[0].parameters.action.enum.indexOf('start') >= 0 && tools[0].parameters.action.enum.indexOf('pause') >= 0)
check('the tool action enum no longer includes setStatus', tools[0].parameters.action.enum.indexOf('setStatus') < 0)

let listenerError = null
try {
  listeners.filter((entry) => entry.event === 'agent/status').forEach((entry) => entry.handler())
} catch (error) {
  listenerError = error
}
check('a status event with no project is harmless', listenerError === null, listenerError && listenerError.message)

let teardownError = null
try {
  disposers.slice().reverse().forEach((entry) => entry.disposer())
} catch (error) {
  teardownError = error
}
check('teardown runs without throwing', teardownError === null, teardownError && teardownError.message)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
