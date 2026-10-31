import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NO_AGENT_PLUGINS } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaybookFile } from '../agents/playbookFiles'
import { installGenerated } from './generatedFolder'
import {
  cleanOldGenerations,
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
  files: [],
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

describe.skipIf(process.platform === 'darwin')('sweeping old generations', () => {
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
    expect(existsSync(join(first, 'codex', 'session-context.md'))).toBe(false)
    expect(existsSync(join(first, 'claude-plugin'))).toBe(false)
    expect(existsSync(join(first, 'marker.txt'))).toBe(true)
    expect(existsSync(third)).toBe(true)
    rmSync(first, { recursive: true, force: true })
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

const DAY = 24 * 60 * 60 * 1000

function age(dir: string, days: number): void {
  const when = new Date(Date.now() - days * DAY)
  utimesSync(dir, when, when)
}

const shellsDir = (): string => dirname(shellIntegrationSpawnOptions('/bin/bash', {}).args[1] ?? '')

function earlierGeneration(root: string, digest: string, days: number): string {
  const dir = installGenerated(root, join(root, digest), ['init.txt'], (staging) =>
    writeFileSync(join(staging, 'init.txt'), 'older build'),
  )
  age(dir, days)
  return dir
}

describe('cleaning generations of earlier builds', () => {
  const made: string[] = []
  const earlier = (root: string, digest: string, days: number): string => {
    const dir = earlierGeneration(root, digest, days)
    made.push(dir)
    return dir
  }

  afterEach(() => {
    for (const pane of ['kept-1', 'kept-2']) releaseAgentDir(pane)
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('removes generations untouched for more than 30 days and keeps the current and recent ones', () => {
    const currentShells = shellsDir()
    const currentAgents = spawnDir()
    age(currentShells, 60)
    age(currentAgents, 60)
    const oldShells = earlier(dirname(currentShells), 'e'.repeat(32), 31)
    const oldAgents = earlier(dirname(currentAgents), 'e'.repeat(32), 31)
    const recentAgents = earlier(dirname(currentAgents), 'd'.repeat(32), 29)
    expect(cleanOldGenerations([], Date.now(), 'darwin').sort()).toEqual(
      [oldAgents, oldShells].sort(),
    )
    expect(existsSync(oldShells)).toBe(false)
    expect(existsSync(oldAgents)).toBe(false)
    expect(existsSync(join(recentAgents, 'init.txt'))).toBe(true)
    expect(existsSync(join(currentShells, 'bashrc'))).toBe(true)
    expect(existsSync(join(currentAgents, 'codex', 'session-context.md'))).toBe(true)
  })

  it('keeps the generation of a kept shell from an older build for as long as the shell lives', () => {
    const older = earlier(dirname(spawnDir()), 'a'.repeat(32), 45)
    cleanOldGenerations([older], Date.now(), 'darwin')
    expect(existsSync(join(older, 'init.txt'))).toBe(true)

    retainAgentDir('kept-1', older)
    age(older, 45)
    cleanOldGenerations([], Date.now(), 'darwin')
    expect(existsSync(join(older, 'init.txt'))).toBe(true)

    releaseAgentDir('kept-1')
    age(older, 45)
    cleanOldGenerations([], Date.now(), 'darwin')
    expect(existsSync(older)).toBe(false)
  })

  it('touches the generation it keeps, so another build counts it as in use', () => {
    const older = earlier(dirname(spawnDir()), 'b'.repeat(32), 45)
    cleanOldGenerations([older], Date.now(), 'darwin')
    cleanOldGenerations([], Date.now(), 'darwin')
    expect(existsSync(join(older, 'init.txt'))).toBe(true)
  })

  it('leaves every agent generation while a kept shell does not record which one it uses', () => {
    const older = earlier(dirname(spawnDir()), 'c'.repeat(32), 45)
    cleanOldGenerations([undefined], Date.now(), 'darwin')
    expect(existsSync(join(older, 'init.txt'))).toBe(true)

    retainAgentDir('kept-2', undefined)
    cleanOldGenerations([], Date.now(), 'darwin')
    expect(existsSync(join(older, 'init.txt'))).toBe(true)

    releaseAgentDir('kept-2')
    cleanOldGenerations([null], Date.now(), 'darwin')
    expect(existsSync(older)).toBe(false)
  })

  it('removes nothing on Linux', () => {
    const older = earlier(dirname(spawnDir()), '0'.repeat(32), 45)
    expect(cleanOldGenerations([], Date.now(), 'linux')).toEqual([])
    expect(existsSync(join(older, 'init.txt'))).toBe(true)
  })

  it.runIf(process.platform === 'darwin')('touches the generations a spawn runs in', () => {
    const agents = spawnDir()
    const shells = shellsDir()
    age(agents, 45)
    age(shells, 45)
    const before = Date.now() - DAY
    spawnDir()
    expect(statSync(agents).mtimeMs).toBeGreaterThan(before)
    expect(statSync(shells).mtimeMs).toBeGreaterThan(before)
  })
})

describe.runIf(process.platform === 'darwin')('rebuilding the agent plugin on macOS', () => {
  afterEach(() => {
    releaseAgentDir('own-pane')
  })

  it('keeps the generation a waiting kept shell of another build runs in', () => {
    const shared = spawnDir()
    cleanOldGenerations([shared])
    files = [playbook('coordinator')]
    refreshAgentPlugin()
    expect(spawnDir()).not.toBe(shared)
    expect(existsSync(join(shared, 'codex', 'session-context.md'))).toBe(true)
  })

  it('keeps a generation after the last pane of this build that used it closes', () => {
    const first = spawnDir()
    retainAgentDir('own-pane', first)
    files = [playbook('review')]
    refreshAgentPlugin()
    releaseAgentDir('own-pane')
    expect(existsSync(join(first, 'codex', 'session-context.md'))).toBe(true)
  })
})
