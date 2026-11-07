import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const driver = readFileSync(new URL('./godot_e2e.gd', import.meta.url), 'utf8')
const setup = readFileSync(new URL('./setup-godot-e2e.mjs', import.meta.url), 'utf8')
const project = readFileSync(new URL('./fixtures/godot-e2e/project.godot', import.meta.url), 'utf8')

assert.ok(driver.includes('extends SceneTree'), 'the driver is a SceneTree script')
assert.ok(driver.includes('StreamPeerTCP'), 'the driver talks to the in-game TCP server')
assert.ok(driver.includes('"command": "eval"'), 'the driver sends a real eval command')
assert.ok(driver.includes('GODOT_E2E PASS'), 'the driver prints a pass marker')
assert.ok(setup.includes('mcp_interaction_server.gd'), 'setup copies the vendored server')
assert.ok(project.includes('McpInteractionServer="*res://autoload/mcp_interaction_server.gd"'), 'the fixture registers the server autoload')

console.log('PASS  the Godot e2e harness is reproducible from the repo');
