import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_AGENT_PLUGINS } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlaybookFile } from '../agents/playbookFiles'
import { listSkills, loadSkill } from '../chat/chatSkills'
import { agentPluginFiles, writeAgentPlugin } from './agentPlugin'

const coordinator: PlaybookFile = {
  id: 'coordinator',
  description: 'Plan, dispatch, review and merge.',
  skill:
    '---\nname: coordinator\ndescription: "Plan."\ndisable-model-invocation: true\n---\n\nBody.\n',
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-plugin-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('writeAgentPlugin with playbooks', () => {
  it('writes each playbook into the Claude plugin and the Codex folder', () => {
    const dir = writeAgentPlugin(root, NO_AGENT_PLUGINS, [coordinator])
    expect(
      readFileSync(join(dir, 'claude-plugin', 'skills', 'coordinator', 'SKILL.md'), 'utf8'),
    ).toBe(coordinator.skill)
    expect(readFileSync(join(dir, 'codex', 'playbooks', 'coordinator', 'SKILL.md'), 'utf8')).toBe(
      coordinator.skill,
    )
    expect(agentPluginFiles(NO_AGENT_PLUGINS, [coordinator])).toContain(
      join('claude-plugin', 'skills', 'coordinator', 'SKILL.md'),
    )
  })

  it('names the playbooks apart from the extension skills in the Codex context, human-typed only', () => {
    const dir = writeAgentPlugin(root, NO_AGENT_PLUGINS, [coordinator])
    const context = readFileSync(join(dir, 'codex', 'session-context.md'), 'utf8')
    expect(context).toContain('only the human uses')
    expect(context).toContain('when the human types its /name')
    expect(context).toContain(
      `- /coordinator (${join(dir, 'codex', 'playbooks', 'coordinator', 'SKILL.md')})`,
    )
    expect(context).not.toContain(coordinator.description)
    expect(context).not.toContain('extensions the human enabled')
  })

  it('says nothing about playbooks when none is on', () => {
    const dir = writeAgentPlugin(root, NO_AGENT_PLUGINS, [])
    expect(readFileSync(join(dir, 'codex', 'session-context.md'), 'utf8')).not.toContain('playbook')
    expect(existsSync(join(dir, 'codex', 'playbooks'))).toBe(false)
  })

  it('makes a new generation for a change and never rewrites the old one', () => {
    const first = writeAgentPlugin(root, NO_AGENT_PLUGINS, [coordinator])
    const again = writeAgentPlugin(root, NO_AGENT_PLUGINS, [coordinator])
    expect(again).toBe(first)
    const marker = join(first, 'claude-plugin', 'skills', 'coordinator', 'SKILL.md')
    writeFileSync(marker, 'kept as written', 'utf8')
    const edited = { ...coordinator, skill: `${coordinator.skill}More.\n` }
    const second = writeAgentPlugin(root, NO_AGENT_PLUGINS, [edited])
    const none = writeAgentPlugin(root, NO_AGENT_PLUGINS, [])
    expect(new Set([first, second, none]).size).toBe(3)
    expect(readFileSync(marker, 'utf8')).toBe('kept as written')
    expect(readdirSync(root).filter((n) => !n.startsWith('.'))).toHaveLength(3)
  })

  it('lets the Agent pane and Chat load a playbook by name', () => {
    const dir = writeAgentPlugin(root, NO_AGENT_PLUGINS, [coordinator])
    const folders = [join(dir, 'codex', 'playbooks')]
    expect(listSkills(folders).map((s) => s.name)).toEqual(['coordinator'])
    const loaded = loadSkill(folders, 'coordinator')
    expect(loaded.ok && loaded.body).toContain('Body.')
  })
})
