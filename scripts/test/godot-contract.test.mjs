import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const bridge = readFileSync(new URL('../../plugin/godot-bridge.mjs', import.meta.url), 'utf8')
const server = readFileSync(new URL('../../plugin/mcp_interaction_server.gd', import.meta.url), 'utf8')
const operations = readFileSync(new URL('../../plugin/godot_operations.gd', import.meta.url), 'utf8')

function quotedList(source, name) {
  const block = source.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\n  \\]'))
  assert.ok(block, name + ' declaration is present')
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
}

function matchCases(source, label) {
  const start = source.indexOf('match ' + label + ':')
  assert.ok(start >= 0, 'match ' + label + ': is present')
  const rest = source.slice(start + ('match ' + label + ':').length)
  const fallback = rest.match(/^\s*_:\s*$/m)
  assert.ok(fallback, 'match ' + label + ': has a fallback branch')
  const block = rest.slice(0, fallback.index)
  return [...block.matchAll(/^\s*"([^"]+)":\s*$/gm)].map((match) => match[1])
}

const commands = quotedList(bridge, 'COMMANDS')
const serverCommands = matchCases(server, 'command')
assert.deepEqual(serverCommands, commands, 'the tool enum and the in-game match block list the same commands in the same order')
assert.equal(new Set(commands).size, commands.length, 'the tool enum has no duplicate command')

const headlessOps = quotedList(bridge, 'HEADLESS_OPS')
const operationCases = matchCases(operations, 'operation')
assert.deepEqual(operationCases, headlessOps, 'the headless operation enum and the .gd match block list the same operations in the same order')
assert.equal(new Set(headlessOps).size, headlessOps.length, 'the headless operation enum has no duplicate operation')

console.log('PASS  godot_command and godot_operations enums match their .gd handlers')
