#!/usr/bin/env node
/**
 * Materialise the disposable Godot e2e project under .investigate/godot-e2e.
 * The vendored server and the e2e driver stay single-source: this script copies
 * them into the project instead of duplicating 5k lines in a fixture.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const target = join(root, '.investigate', 'godot-e2e')
rmSync(target, { recursive: true, force: true })
mkdirSync(join(target, 'autoload'), { recursive: true })
cpSync(join(root, 'scripts', 'test', 'fixtures', 'godot-e2e', 'project.godot'), join(target, 'project.godot'))
cpSync(join(root, 'scripts', 'test', 'fixtures', 'godot-e2e', 'main.tscn'), join(target, 'main.tscn'))
cpSync(join(root, 'plugin', 'mcp_interaction_server.gd'), join(target, 'autoload', 'mcp_interaction_server.gd'))
cpSync(join(root, 'scripts', 'test', 'godot_e2e.gd'), join(target, 'godot_e2e.gd'))
console.log(target)
