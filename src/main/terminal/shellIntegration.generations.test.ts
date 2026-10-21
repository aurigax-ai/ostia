import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NO_AGENT_PLUGINS } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaybookFile } from '../agents/playbookFiles'
import {
  playbooksFolder,
  refreshAgentPlugin,
  releaseAgentDir,
  retainAgentDir,
  setAgentPlugins,
  setPlaybookSource,
  shellIntegrationSpawnOptions,
} from './shellIntegration'

const playbook = (id: string, body = 'Body.'): PlaybookFile => ({
  id,
  description: `About ${id}.`,
  skill: `---\nname: ${id}\ndescription: "About ${id}."\ndisable-model-invocation: true\n---\n\n${body}\n`,
})

const spawnDir = (): string => shellIntegrationSpawnOptions('/bin/bash', {}).agentDir ?? ''

let files: PlaybookFile[]
const source = vi.fn((_taken: readonly string[]) => files)

beforeEach(() => {
  files = []
  source.mockClear()
  setPlaybookSource(source)
  setAgentPlugins(NO_AGENT_PLUGINS)
  source.mockClear()
})

afterEach(() => {
  setPlaybookSource(() => [])
  setAgentPlugins(NO_AGENT_PLUGINS)
})

describe('the agent plugin generation', () => {
  it('is computed on a change, not on every spawn', () => {
    const first = spawnDir()
    spawnDir()
    spawnDir()
    expect(source).not.toHaveBeenCalled()
    files = [playbook('coordinator')]
    refreshAgentPlugin()
    expect(source).toHaveBeenCalledTimes(1)
    const next = spawnDir()
    expect(next).not.toBe(first)
    expect(existsSync(join(next, 'claude-plugin', 'skills', 'coordinator', 'SKILL.md'))).toBe(true)
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('is written again at the next spawn when its files were cleaned away', () => {
    const dir = spawnDir()
    rmSync(join(dir, 'codex', 'session-context.md'))
    expect(spawnDir()).toBe(dir)
    expect(existsSync(join(dir, 'codex', 'session-context.md'))).toBe(true)
  })

  it('gives the Agent pane and Chat the folder of the current generation', () => {
    files = [playbook('worker')]
    refreshAgentPlugin()
    expect(playbooksFolder()).toBe(join(spawnDir(), 'codex', 'playbooks'))
  })

  it('leaves out playbooks that clash with an extension skill, using the ids it passes on', () => {
    setAgentPlugins({
      hooks: [],
      skills: [{ id: 'kit-review', description: 'd', files: [] }],
    })
    expect(source).toHaveBeenLastCalledWith(['kit-review'])
  })
})

describe('sweeping old generations', () => {
  it('removes a generation nothing runs in and never rewrites one that is in use', () => {
    const first = spawnDir()
    retainAgentDir('pane-1', first)
    writeFileSync(join(first, 'marker.txt'), 'kept as written')
    files = [playbook('coordinator')]
    refreshAgentPlugin()
    const second = spawnDir()
    expect(second).not.toBe(first)
    expect(existsSync(join(first, 'marker.txt'))).toBe(true)

    files = [playbook('coordinator', 'Edited.')]
    refreshAgentPlugin()
    const third = spawnDir()
    expect(existsSync(second)).toBe(false)
    expect(existsSync(third)).toBe(true)
    expect(existsSync(first)).toBe(true)

    releaseAgentDir('pane-1')
    expect(existsSync(first)).toBe(false)
    expect(existsSync(third)).toBe(true)
  })

  it('keeps the generation while any pane still runs in it', () => {
    const first = spawnDir()
    retainAgentDir('a', first)
    retainAgentDir('b', first)
    files = [playbook('review')]
    refreshAgentPlugin()
    releaseAgentDir('a')
    expect(existsSync(first)).toBe(true)
    releaseAgentDir('b')
    expect(existsSync(first)).toBe(false)
  })

  it('never touches a generation from an earlier session, which a kept shell may still use', () => {
    const root = dirname(spawnDir())
    const earlier = join(root, 'f'.repeat(32))
    mkdirSync(earlier, { recursive: true })
    files = [playbook('worker')]
    refreshAgentPlugin()
    files = []
    refreshAgentPlugin()
    expect(existsSync(earlier)).toBe(true)
    rmSync(earlier, { recursive: true, force: true })
  })
})
