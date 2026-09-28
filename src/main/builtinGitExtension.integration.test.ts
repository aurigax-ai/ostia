import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExtensionCaller, ExtensionSidebarItem } from '../shared/extensions'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { ExtensionStore } from './extensionStore'
import { registerPane } from './idRegistry'
import { registerPaneListMethods } from './paneList'

const repoRoot = process.cwd()

async function until<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('built-in git extension against a real repository', () => {
  let dir: string
  let repo: string
  let host: ExtensionHost
  const broadcasts: { channel: string; payload: unknown }[] = []
  const openDiffIn = vi.fn()
  const openPanelIn = vi.fn()

  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
  const sidebar = (): ExtensionSidebarItem[] =>
    (broadcasts.filter((b) => b.channel === 'extensions:sidebar').at(-1)?.payload ??
      []) as ExtensionSidebarItem[]
  const itemText = (sessionId: string): string | undefined =>
    sidebar().find((i) => i.extId === 'git' && i.sessionId === sessionId)?.text
  const caller = (cwd?: string): ExtensionCaller => ({
    kind: 'pane',
    sessionId: 's1',
    ...(cwd ? { cwd } : {}),
    capabilities: ['read-board'],
  })

  beforeAll(() => {
    execSync('pnpm run build:extensions', { cwd: repoRoot, stdio: 'ignore' })
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pine-git-ext-')))
    repo = join(dir, 'repo')
    mkdirSync(join(repo, 'sub'), { recursive: true })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    writeFileSync(join(repo, 'sub', 'b.txt'), 'bee\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'sub', 'b.txt'), 'bee staged\n')
    git('add', 'sub/b.txt')
    writeFileSync(join(repo, 'c new.txt'), 'fresh\n')

    const socketPath = join(dir, 'control.sock')
    const identity = registerPane({ windowId: 'w1', sessionId: 's1', paneId: 'p-git' })
    const other = registerPane({ windowId: 'w1', sessionId: 's2', paneId: 'p-plain' })
    registerPaneListMethods({
      execCommand: async (_target, id) =>
        ({
          ok: true,
          result:
            id === 'session.list'
              ? [
                  {
                    sessionId: 's1',
                    name: 'r',
                    kind: 'terminal',
                    workDir: repo,
                    state: 'idle',
                    activePaneId: 'p-git',
                  },
                  {
                    sessionId: 's2',
                    name: 'x',
                    kind: 'terminal',
                    workDir: dir,
                    state: 'idle',
                    activePaneId: 'p-plain',
                  },
                ]
              : [
                  {
                    paneId: 'p-git',
                    sessionId: 's1',
                    kind: 'terminal',
                    title: 'zsh',
                    cwd: join(repo, 'sub'),
                  },
                  { paneId: 'p-plain', sessionId: 's2', kind: 'terminal', title: 'zsh', cwd: dir },
                ],
        }) as CommandResult,
      getTerminalState: () => undefined,
    })
    expect(identity.externalId).not.toBe(other.externalId)
    host = new ExtensionHost({
      roots: [{ dir: join(repoRoot, 'out', 'extensions'), builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForSession: (sid) => (sid === 's1' ? repo : dir),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      openPanelIn,
      openDiffIn,
      notify: () => {},
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
      },
      socketPath,
    )
    host.startEager()
  })

  afterAll(() => {
    host.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('shows the branch and +new ~changed for a repo session and nothing for a plain dir', async () => {
    expect(await until(() => itemText('s1'))).toBe('main +1 ~2')
    const item = sidebar().find((i) => i.sessionId === 's1')
    expect(item).toMatchObject({ icon: 'git-branch', tone: 'neutral', key: 'branch' })
    expect(itemText('s2')).toBeUndefined()
  })

  it('updates the sidebar after a command finishes', async () => {
    writeFileSync(join(repo, 'd.txt'), 'another\n')
    host.emitEvent('command.finished', { paneId: 'x', sessionId: 's1', exitCode: 0 })
    expect(await until(() => (itemText('s1') === 'main +2 ~2' ? itemText('s1') : undefined))).toBe(
      'main +2 ~2',
    )
    rmSync(join(repo, 'd.txt'))
    host.emitEvent('command.finished', { paneId: 'x', sessionId: 's1', exitCode: 0 })
    await until(() => (itemText('s1') === 'main +1 ~2' ? true : undefined))
  })

  it('lists staged, unstaged and untracked changes for the session repo', async () => {
    const res = await host.invoke('git', 'changes', null, caller())
    expect(res.ok).toBe(true)
    const data = res.ok ? (res.data as { root: string; changes: unknown[] }) : null
    expect(data?.root).toBe(repo)
    expect(data?.changes).toEqual([
      { path: 'a.txt', area: 'unstaged', code: 'M' },
      { path: 'sub/b.txt', area: 'staged', code: 'M' },
      { path: 'c new.txt', area: 'untracked', code: '?' },
    ])
  })

  it('reports branch and counts as JSON for status', async () => {
    const res = await host.invoke('git', 'status', { argv: [] }, caller(repo))
    expect(res).toMatchObject({
      ok: true,
      data: {
        root: repo,
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0 },
        counts: { added: 1, changed: 2, staged: 1, unstaged: 1, untracked: 1 },
      },
    })
  })

  it('opens an unstaged diff: index on the left, working file on the right', async () => {
    openDiffIn.mockClear()
    const res = await host.invoke('git', 'open', { argv: ['a.txt'] }, caller(repo))
    expect(res).toMatchObject({ ok: true, data: { opened: 'a.txt', area: 'unstaged' } })
    expect(openDiffIn).toHaveBeenCalledWith({
      extId: 'git',
      sessionId: 's1',
      title: 'a.txt (unstaged)',
      original: 'one\n',
      modified: 'one\ntwo\n',
      path: join(repo, 'a.txt'),
    })
  })

  it('opens a staged diff (HEAD vs index) resolving the path from the caller cwd', async () => {
    openDiffIn.mockClear()
    const res = await host.invoke(
      'git',
      'open',
      { argv: ['b.txt', '--staged'] },
      caller(join(repo, 'sub')),
    )
    expect(res.ok).toBe(true)
    expect(openDiffIn.mock.calls[0][0]).toMatchObject({
      original: 'bee\n',
      modified: 'bee staged\n',
      path: join(repo, 'sub', 'b.txt'),
    })
  })

  it('opens an untracked file against an empty original, from an absolute path (panel)', async () => {
    openDiffIn.mockClear()
    const res = await host.invoke(
      'git',
      'open',
      { path: join(repo, 'c new.txt'), area: 'untracked' },
      { kind: 'user', sessionId: 's1', capabilities: ['read-board'] },
    )
    expect(res.ok).toBe(true)
    expect(openDiffIn.mock.calls[0][0]).toMatchObject({ original: '', modified: 'fresh\n' })
  })

  it('returns a unified patch for diff', async () => {
    const res = await host.invoke('git', 'diff', { argv: ['a.txt'] }, caller(repo))
    expect(res).toMatchObject({ ok: true, data: { path: 'a.txt', area: 'unstaged', code: 'M' } })
    expect(res.ok && (res.data as { patch: string }).patch).toContain('+two')
  })

  it('fails clearly outside a repo and for files without changes', async () => {
    expect(await host.invoke('git', 'status', null, caller(dir))).toMatchObject({
      ok: false,
      error: 'not-a-repo',
    })
    expect(await host.invoke('git', 'diff', { argv: ['sub/b.txt'] }, caller(repo))).toMatchObject({
      ok: true,
    })
    expect(await host.invoke('git', 'diff', { argv: ['nope.txt'] }, caller(repo))).toMatchObject({
      ok: false,
      error: 'not-changed',
    })
    expect(await host.invoke('git', 'diff', { argv: [] }, caller(repo))).toMatchObject({
      ok: false,
      error: 'invalid-args',
    })
  })

  it('shows a symlink as its target path instead of reading through it', async () => {
    const secret = join(dir, 'outside-secret.txt')
    writeFileSync(secret, 'do not read\n')
    symlinkSync(secret, join(repo, 'link'))
    openDiffIn.mockClear()
    try {
      const res = await host.invoke('git', 'open', { argv: ['link'] }, caller(repo))
      expect(res.ok).toBe(true)
      expect(openDiffIn.mock.calls[0][0]).toMatchObject({ original: '', modified: secret })
    } finally {
      rmSync(join(repo, 'link'))
    }
  })

  it('opens its panel in the caller session for "Show Changes"', async () => {
    const res = await host.invoke('git', 'show', null, caller())
    expect(res.ok).toBe(true)
    expect(openPanelIn).toHaveBeenCalledWith({ extId: 'git', sessionId: 's1' })
    const panel = await host.resolvePanel('git', { sessionId: 's1', locale: 'en' })
    expect(panel.ok && panel.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?/)
  })
})
