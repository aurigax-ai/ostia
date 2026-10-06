import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { PaneInfo, WorkspaceInfo } from '../extensions/sdk'
import type {
  ExtensionEventType,
  ExtensionSettingValues,
  ExtensionSidebarItem,
  WorkspaceChip,
} from '../shared/extensions'
import { GIT_EXTENSION, GitBoard, type GitBoardHost } from './gitBoard'

type Listener = (type: ExtensionEventType, payload: unknown) => void

function fakeHost() {
  const sidebar = new Map<string, ExtensionSidebarItem>()
  const chips = new Map<string, WorkspaceChip>()
  const listeners = new Set<Listener>()
  const watchers = new Set<() => void>()
  const state = { enabled: true, settings: {} as ExtensionSettingValues, published: 0 }
  const host: GitBoardHost = {
    isEnabled: () => state.enabled,
    settingValuesOf: () => state.settings,
    sidebarItems: () => [...sidebar.values()],
    workspaceChips: () => [...chips.values()],
    publishSidebarItem: (extId, params) => {
      const p = params as { workspaceId: string; key: string; text: string }
      state.published += 1
      if (p.text)
        sidebar.set(p.workspaceId, {
          extId,
          key: p.key,
          text: p.text,
          tone: 'neutral',
          workspaceId: p.workspaceId,
          kind: 'location',
        })
      else sidebar.delete(p.workspaceId)
      return { ok: true }
    },
    publishWorkspaceChip: (extId, params) => {
      const p = params as { workspaceId: string; id: string; text: string; command?: string }
      state.published += 1
      const key = `${p.workspaceId}/${p.id}`
      if (p.text) {
        chips.set(key, {
          extId,
          id: p.id,
          text: p.text,
          tone: 'neutral',
          workspaceId: p.workspaceId,
          ...(p.command ? { command: p.command } : {}),
        })
      } else chips.delete(key)
      return { ok: true }
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    watch: (_extId, listener) => {
      watchers.add(listener)
      return () => watchers.delete(listener)
    },
  }
  return {
    host,
    state,
    sidebar,
    chips,
    emit: (type: ExtensionEventType, payload: unknown = {}) => {
      for (const l of listeners) l(type, payload)
    },
    changed: () => {
      for (const w of watchers) w()
    },
    listening: () => listeners.size + watchers.size,
  }
}

async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('GitBoard', () => {
  let dir: string
  let repo: string
  let plain: string
  let cwd: string
  let board: GitBoard | null = null

  const workspaces = async (): Promise<WorkspaceInfo[]> => [
    {
      workspaceId: 'w1',
      name: 'r',
      kind: 'terminal',
      workDir: repo,
      state: 'idle',
      activePaneId: 'p1',
    },
  ]
  const panes = async (): Promise<PaneInfo[]> => [
    {
      paneId: 'p1',
      workspaceId: 'w1',
      kind: 'terminal',
      title: 'zsh',
      cwd,
      running: false,
      blockCount: 0,
    },
  ]

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-git-board-')))
    repo = join(dir, 'repo')
    plain = join(dir, 'plain')
    mkdirSync(repo)
    mkdirSync(plain)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo })
    git('init', '-q', '-b', 'trunk')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  })

  afterEach(() => {
    board?.stop()
    board = null
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('shows the branch in the sidebar and the branch and diff stats chips for a repo workspace', async () => {
    cwd = repo
    const fake = fakeHost()
    board = new GitBoard({ host: fake.host, listWorkspaces: workspaces, listPanes: panes })
    board.start()
    expect((await until(() => fake.sidebar.get('w1'))).text).toBe('trunk')
    expect(await until(() => fake.chips.get('w1/branch'))).toMatchObject({
      extId: GIT_EXTENSION,
      text: 'trunk',
      command: 'show',
    })
    expect((await until(() => fake.chips.get('w1/diff-stats'))).text).toBe('1 • +1')
  })

  it('publishes nothing while the git extension is disabled', async () => {
    cwd = repo
    const fake = fakeHost()
    fake.state.enabled = false
    board = new GitBoard({ host: fake.host, listWorkspaces: workspaces, listPanes: panes })
    board.start()
    await new Promise((r) => setTimeout(r, 300))
    expect(fake.state.published).toBe(0)
    fake.state.enabled = true
    fake.changed()
    expect((await until(() => fake.sidebar.get('w1'))).text).toBe('trunk')
  })

  it('drops the branch when the terminal leaves the repo and puts it back after the host cleared it', async () => {
    cwd = repo
    const fake = fakeHost()
    board = new GitBoard({ host: fake.host, listWorkspaces: workspaces, listPanes: panes })
    board.start()
    await until(() => fake.chips.get('w1/branch'))
    cwd = plain
    fake.emit('cwd.changed', { paneId: 'p1', workspaceId: 'w1', cwd: plain })
    await until(() => (fake.sidebar.has('w1') || fake.chips.size > 0 ? undefined : true))
    cwd = repo
    fake.sidebar.clear()
    fake.chips.clear()
    fake.emit('command.finished', { paneId: 'p1', workspaceId: 'w1', exitCode: 0 })
    expect((await until(() => fake.sidebar.get('w1'))).text).toBe('trunk')
  })

  it('hides the diff stats chip when showDiffStats is off', async () => {
    cwd = repo
    const fake = fakeHost()
    board = new GitBoard({ host: fake.host, listWorkspaces: workspaces, listPanes: panes })
    board.start()
    await until(() => fake.chips.get('w1/diff-stats'))
    fake.state.settings = { showDiffStats: false }
    fake.changed()
    await until(() => (fake.chips.has('w1/diff-stats') ? undefined : true))
    expect(fake.chips.get('w1/branch')?.text).toBe('trunk')
  })

  it('stops listening when stopped', () => {
    cwd = repo
    const fake = fakeHost()
    const stopped = new GitBoard({ host: fake.host, listWorkspaces: workspaces, listPanes: panes })
    stopped.start()
    expect(fake.listening()).toBe(2)
    stopped.stop()
    expect(fake.listening()).toBe(0)
  })
})
