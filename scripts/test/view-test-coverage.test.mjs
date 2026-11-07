import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const viewsDir = new URL('../../client/src/views/', import.meta.url)
const testsDir = new URL('./', import.meta.url)
const modules = readdirSync(viewsDir).filter((name) => name.endsWith('.cjs')).sort()
assert.ok(modules.length > 0, 'there is at least one view module')
const testFiles = readdirSync(testsDir).filter((name) => name.startsWith('client-') && name.endsWith('.test.mjs')).sort()
const testSources = new Map(testFiles.map((name) => [name, readFileSync(new URL(name, testsDir), 'utf8')]))

for (const name of modules) {
  const owner = testFiles.find((file) => testSources.get(file).includes('client/src/views/' + name))
  assert.ok(owner, name + ' has an independent test that requires it')
  assert.ok(/\bassert\./.test(testSources.get(owner)), owner + ' makes assertions')
}

for (const name of ['selectors.cjs', 'store.cjs']) {
  assert.ok(testFiles.some((file) => testSources.get(file).includes('client/src/' + name)), name + ' has an independent test')
}

console.log('PASS  every view module has an independent test');
