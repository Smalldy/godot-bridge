#!/usr/bin/env node
// Build the browser half from client/src/*.part into client/client.js.
//
// The parts are fragments of one classic script (the DSH module loader wraps the
// factory); they are deliberately not standalone JS, so check:syntax only sees
// the generated bundle. Keep this script dependency-free: the repository has no
// bundler, and the output is one plain script.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'client', 'src')
const OUT = join(ROOT, 'client', 'client.js')
const REQUIRED = ['00-head.part', '10-selectors.part', '20-store.part', '30-views.part', '40-tail.part']

const present = readdirSync(SRC).filter((name) => name.endsWith('.part')).sort()
const missing = REQUIRED.filter((name) => present.indexOf(name) < 0)
if (missing.length > 0) {
  console.error('build:client: missing part(s): ' + missing.join(', '))
  process.exit(1)
}
const bundle = present.map((name) => readFileSync(join(SRC, name), 'utf8')).join('')
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
