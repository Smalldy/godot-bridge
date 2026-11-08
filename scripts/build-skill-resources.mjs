#!/usr/bin/env node
/**
 * Generate the task center's reference resource from the live action registry.
 * The reference is a plain resource file under plugin/task-center/skills/; it
 * is not a skill. Run after changing actions/registry.mjs.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACTIONS, AGENT_ACTIONS, READ_ACTIONS, USER_ONLY_ACTIONS } from '../plugin/task-center/actions/registry.mjs'
import { buildReferenceContent, SKILL_RESOURCE_DIR } from '../plugin/task-center/skill.mjs'

const markdown = buildReferenceContent({
  actions: ACTIONS,
  agentActions: AGENT_ACTIONS,
  readActions: READ_ACTIONS,
  userOnlyActions: USER_ONLY_ACTIONS,
})
const target = join(SKILL_RESOURCE_DIR, 'reference.md')
writeFileSync(target, markdown.endsWith('\n') ? markdown : markdown + '\n', 'utf8')
console.log('wrote ' + target + ' (' + Buffer.byteLength(markdown, 'utf8') + ' bytes)')
