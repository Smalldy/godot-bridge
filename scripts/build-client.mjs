#!/usr/bin/env node
// Build the browser half from client/src into client/client.js.
//
// The bundle is one classic script: the DSH module loader wraps a factory.
// Pure selectors and the Host-backed store are CommonJS modules so they can be
// unit-tested; this script inlines them into the factory scope with tiny
// wrappers. Everything else is still a .part fragment.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'client', 'src')
const OUT = join(ROOT, 'client', 'client.js')
const VIEW_PARTS = [
  '30-views-core.part',
  '31-views-queue.part',
  '32-views-roles.part',
  '33-views-status.part',
  '34-views-detail.part',
  '35-views-forms.part',
  '36-views-shell.part',
]
const REQUIRED = ['00-head.part', '15-client-state.part'].concat(VIEW_PARTS).concat(['40-tail.part'])

const present = readdirSync(SRC).filter((name) => name.endsWith('.part')).sort()
const missing = REQUIRED.filter((name) => present.indexOf(name) < 0)
if (missing.length > 0) {
  console.error('build:client: missing part(s): ' + missing.join(', '))
  process.exit(1)
}

function read(name) {
  return readFileSync(join(SRC, name), 'utf8')
}

function exportedNames(source, label) {
  const match = source.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/)
  if (match === null) {
    console.error('build:client: ' + label + ' has no module.exports')
    process.exit(1)
  }
  return match[1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

const selectors = read('selectors.cjs')
const selectorNames = exportedNames(selectors, 'selectors.cjs')
const selectorWrapper =
  '\nconst { ' +
  selectorNames.join(', ') +
  ' } = (function () {\n' +
  '\tconst module = { exports: {} }\n' +
  '\t;(function (module, exports) {\n' +
  selectors +
  '\n\t})(module, module.exports)\n' +
  '\treturn module.exports\n' +
  '})()\n'

const store = read('store.cjs')
const storeNames = exportedNames(store, 'store.cjs')
const depsMatch = store.match(/const \{([\s\S]*?)\} = deps/)
if (depsMatch === null) {
  console.error('build:client: store.cjs has no deps destructure')
  process.exit(1)
}
const storeDeps = depsMatch[1]
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0)
const storeWrapper =
  '\nconst createTaskStore = (function () {\n' +
  '\tconst module = { exports: {} }\n' +
  '\t;(function (module, exports) {\n' +
  store +
  '\n\t})(module, module.exports)\n' +
  '\tconst factory = module.exports.createTaskStore\n' +
  '\treturn function (t) {\n' +
  '\t\treturn factory(t, {\n' +
  storeDeps.map((name) => '\t\t\t' + name + ': ' + name + ',').join('\n') +
  '\n\t\t})\n' +
  '\t}\n' +
  '})()\n'

const bundle =
  read('00-head.part') +
  selectorWrapper +
  read('15-client-state.part') +
  storeWrapper +
  VIEW_PARTS.map((name) => read(name)).join('') +
  read('40-tail.part')

const check = process.argv.indexOf('--check') >= 0
if (check) {
  const current = readFileSync(OUT, 'utf8')
  if (current !== bundle) {
    console.error('build:client: client/client.js is out of date; run npm run build:client')
    process.exit(1)
  }
  console.log('build:client: client/client.js is up to date (' + String(bundle.length) + ' chars)')
} else {
  writeFileSync(OUT, bundle)
  console.log('build:client: wrote client/client.js (' + String(bundle.length) + ' chars)')
}
