import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  ExtensionCaller,
  ExtensionResult,
  ExtensionSidebarItem,
  PaneChip,
} from '../shared/extensions'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import {
  type ExtensionConfirmRequest,
  ExtensionHost,
  registerExtensionMethods,
} from './extensionHost'
import { ExtensionStore } from './extensionStore'
import { type PaneIdentity, registerPane } from './idRegistry'
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

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 8000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
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
  const confirm = vi.fn<(req: ExtensionConfirmRequest) => Promise<boolean>>()
  let fileIdentity: PaneIdentity

  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
  const sidebar = (): ExtensionSidebarItem[] =>
    (broadcasts.filter((b) => b.channel === 'extensions:sidebar').at(-1)?.payload ??
      []) as ExtensionSidebarItem[]
  const itemText = (workspaceId: string): string | undefined =>
    sidebar().find((i) => i.extId === 'git' && i.workspaceId === workspaceId)?.text
  const caller = (cwd?: string): ExtensionCaller => ({
    kind: 'pane',
    workspaceId: 's1',
    ...(cwd ? { cwd } : {}),
    capabilities: ['read-board'],
  })

  beforeAll(() => {
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
    const identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-git' })
    const other = registerPane({ windowId: 'w1', workspaceId: 's2', paneId: 'p-plain' })
    fileIdentity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-file' })
    registerPaneListMethods({
      execCommand: async (_target, id) =>
        ({
          ok: true,
          result:
            id === 'workspace.list'
              ? [
                  {
                    workspaceId: 's1',
                    name: 'r',
                    kind: 'terminal',
                    workDir: repo,
                    state: 'idle',
                    activePaneId: 'p-git',
                  },
                  {
                    workspaceId: 's2',
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
                    workspaceId: 's1',
                    kind: 'terminal',
                    title: 'zsh',
                    cwd: join(repo, 'sub'),
                  },
                  {
                    paneId: 'p-file',
                    workspaceId: 's1',
                    kind: 'editor',
                    title: 'a.txt',
                    filePath: join(repo, 'a.txt'),
                  },
                  {
                    paneId: 'p-plain',
                    workspaceId: 's2',
                    kind: 'terminal',
                    title: 'zsh',
                    cwd: dir,
                  },
                ],
        }) as CommandResult,
      getTerminalState: () => undefined,
      ptyPid: () => undefined,
      windowIds: () => ['1'],
    })
    expect(identity.externalId).not.toBe(other.externalId)
    host = new ExtensionHost({
      roots: [{ dir: join(repoRoot, 'out', 'extensions'), builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      dataDir: join(dir, 'ext-data'),
      workDirForWorkspace: (sid) => (sid === 's1' ? repo : dir),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      openPanelIn,
      openDiffIn,
      notify: () => {},
      confirm,
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

  it('shows the branch and +new ~changed for a repo workspace and nothing for a plain dir', async () => {
    expect(await until(() => itemText('s1'))).toBe('main +1 ~2')
    const item = sidebar().find((i) => i.workspaceId === 's1')
    expect(item).toMatchObject({ icon: 'git-branch', tone: 'neutral', key: 'branch' })
    expect(itemText('s2')).toBeUndefined()
  })

  it('updates the sidebar after a command finishes', async () => {
    writeFileSync(join(repo, 'd.txt'), 'another\n')
    host.emitEvent('command.finished', { paneId: 'x', workspaceId: 's1', exitCode: 0 })
    expect(await until(() => (itemText('s1') === 'main +2 ~2' ? itemText('s1') : undefined))).toBe(
      'main +2 ~2',
    )
    rmSync(join(repo, 'd.txt'))
    host.emitEvent('command.finished', { paneId: 'x', workspaceId: 's1', exitCode: 0 })
    await until(() => (itemText('s1') === 'main +1 ~2' ? true : undefined))
  })

  it('lists staged, unstaged and untracked changes for the workspace repo', async () => {
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
      workspaceId: 's1',
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
      { kind: 'user', workspaceId: 's1', capabilities: ['read-board'] },
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

  it('opens its panel in the caller workspace for "Show Changes"', async () => {
    const res = await host.invoke('git', 'show', null, caller())
    expect(res.ok).toBe(true)
    expect(openPanelIn).toHaveBeenCalledWith({ extId: 'git', workspaceId: 's1' })
    const panel = await host.resolvePanel('git', { workspaceId: 's1', locale: 'en' })
    expect(panel.ok && panel.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?/)
  })

  const chip = (paneId: string, id: string): PaneChip | undefined =>
    host.paneChips().find((c) => c.extId === 'git' && c.paneId === paneId && c.id === id)

  async function panelCall(command: string, args: unknown): Promise<ExtensionResult> {
    const panel = await host.resolvePanel('git', { workspaceId: 's1', locale: 'en' })
    if (!panel.ok) throw new Error(panel.error)
    const url = new URL(panel.src)
    const res = await fetch(new URL('/api', url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pine-panel': url.searchParams.get('t') ?? '',
      },
      body: JSON.stringify({ command, args, context: { workspaceId: 's1', locale: 'en' } }),
    })
    return (await res.json()) as ExtensionResult
  }

  describe('v2', () => {
    it('puts the branch and diff stats chips on each terminal inside a repo, and nowhere else', async () => {
      expect(await until(() => chip('p-git', 'branch'))).toMatchObject({
        text: 'main',
        command: 'show',
        tone: 'neutral',
      })
      expect(await until(() => chip('p-git', 'diff-stats'))).toMatchObject({ text: '2 • +2 -1' })
      expect(chip('p-plain', 'branch')).toBeUndefined()
      expect(chip('p-file', 'branch')).toBeUndefined()
    })

    it('hides the diff stats chip when the showDiffStats setting is off', async () => {
      expect(host.setSetting('git', 'showDiffStats', false).ok).toBe(true)
      await until(() => (chip('p-git', 'diff-stats') ? undefined : true))
      expect(chip('p-git', 'branch')?.text).toBe('main')
      expect(host.setSetting('git', 'showDiffStats', null).ok).toBe(true)
      expect((await until(() => chip('p-git', 'diff-stats'))).text).toBe('2 • +2 -1')
    })

    it('lists recent commits as text for people and as JSON with --json', async () => {
      const head = git('rev-parse', 'HEAD').trim()
      const text = await host.invoke('git', 'log', { argv: [] }, caller(repo))
      expect(text.ok && text.text).toMatch(
        new RegExp(`^${head.slice(0, 7)} \\d{4}-\\d\\d-\\d\\d Test  init$`),
      )
      const json = await host.invoke('git', 'log', { argv: ['--json'] }, caller(repo))
      expect(json.ok && json.text).toBeUndefined()
      expect(json).toMatchObject({
        ok: true,
        data: {
          root: repo,
          branch: 'main',
          commits: [{ sha: head, author: 'Test', subject: 'init' }],
        },
      })
    })

    it('blames each line, marking lines that are not committed yet', async () => {
      const head = git('rev-parse', 'HEAD').trim()
      const res = await host.invoke(
        'git',
        'blame',
        { argv: ['../a.txt', '--json'] },
        caller(join(repo, 'sub')),
      )
      expect(res).toMatchObject({ ok: true, data: { root: repo, path: 'a.txt' } })
      const lines = res.ok
        ? (res.data as { lines: { sha: string; text: string; author: string }[] }).lines
        : []
      expect(lines.map((l) => l.text)).toEqual(['one', 'two'])
      expect(lines[0]).toMatchObject({ sha: head, author: 'Test' })
      expect(lines[1].sha).toMatch(/^0+$/)
      const text = await host.invoke('git', 'blame', { argv: ['a.txt'] }, caller(repo))
      expect(text.ok && text.text).toContain('Not committed yet\ttwo')
      expect(await host.invoke('git', 'blame', { argv: [] }, caller(repo))).toMatchObject({
        ok: false,
        error: 'invalid-args',
      })
    })

    it('opens the blame page for the active file view from the palette', async () => {
      openPanelIn.mockClear()
      const res = await host.invoke('git', 'blame-file', null, {
        kind: 'user',
        workspaceId: 's1',
        paneId: fileIdentity.externalId,
        capabilities: ['read-board'],
      })
      expect(res.ok).toBe(true)
      const path = `/blame?file=${encodeURIComponent(join(repo, 'a.txt'))}`
      expect(openPanelIn).toHaveBeenCalledWith({ extId: 'git', workspaceId: 's1', path })
      const panel = await host.resolvePanel('git', { workspaceId: 's1', locale: 'en', path })
      const src = new URL(panel.ok ? panel.src : 'http://x/')
      expect(src.searchParams.get('page')).toBe('blame')
      expect(src.searchParams.get('file')).toBe(join(repo, 'a.txt'))
      const blamed = await panelCall('blame', { path: join(repo, 'a.txt') })
      expect(blamed).toMatchObject({ ok: true, data: { path: 'a.txt' } })

      const terminal = await host.invoke('git', 'blame-file', null, caller())
      expect(terminal).toMatchObject({ ok: false, error: 'no-file' })
    })

    it('stages and unstages paths, and everything with --all', async () => {
      const staged = (): string => git('diff', '--cached', '--name-only').trim()
      expect(await host.invoke('git', 'stage', { argv: [] }, caller(repo))).toMatchObject({
        ok: false,
        error: 'invalid-args',
      })
      const res = await host.invoke('git', 'stage', { argv: ['a.txt'] }, caller(repo))
      expect(res).toMatchObject({ ok: true, data: { staged: ['a.txt'], counts: { staged: 2 } } })
      expect(staged()).toBe('a.txt\nsub/b.txt')
      await host.invoke('git', 'unstage', { argv: ['../a.txt'] }, caller(join(repo, 'sub')))
      expect(staged()).toBe('sub/b.txt')
      await host.invoke('git', 'stage', { argv: ['--all'] }, caller(repo))
      expect(staged()).toBe('a.txt\nc new.txt\nsub/b.txt')
      await host.invoke('git', 'unstage', { argv: ['--all'] }, caller(repo))
      expect(staged()).toBe('')
      await panelCall('stage', { paths: [join(repo, 'sub', 'b.txt')] })
      expect(staged()).toBe('sub/b.txt')
    })

    it('discards only after the human confirms, and only from the panel', async () => {
      expect(await host.invoke('git', 'discard', { argv: ['a.txt'] }, caller(repo))).toMatchObject({
        ok: false,
        error: 'unknown-command',
      })
      confirm.mockResolvedValueOnce(false)
      const denied = await panelCall('discard', { paths: [join(repo, 'a.txt')] })
      expect(denied).toMatchObject({ ok: false, error: 'cancelled' })
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(confirm.mock.calls[0][0]).toMatchObject({
        extId: 'git',
        title: 'Discard changes',
        confirmLabel: 'Discard',
      })
      expect(confirm.mock.calls[0][0].detail).toContain('a.txt')
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\n')

      confirm.mockResolvedValueOnce(true)
      const done = await panelCall('discard', { paths: [join(repo, 'a.txt')] })
      expect(done).toMatchObject({ ok: true, data: { discarded: ['a.txt'] } })
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n')
      expect(existsSync(join(repo, 'c new.txt'))).toBe(true)
      expect(git('diff', '--cached', '--name-only').trim()).toBe('sub/b.txt')
    })

    it('commits only the staged changes and reports errors from the tool', async () => {
      expect(
        await host.invoke('git', 'commit', { argv: ['-m', '  '] }, caller(repo)),
      ).toMatchObject({ ok: false, error: 'invalid-args' })
      const res = await host.invoke('git', 'commit', { argv: ['-m', 'stage b'] }, caller(repo))
      const head = git('rev-parse', 'HEAD').trim()
      expect(res).toMatchObject({ ok: true, text: head, data: { sha: head, subject: 'stage b' } })
      expect(git('log', '-1', '--format=%s').trim()).toBe('stage b')
      expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('sub/b.txt')
      expect(git('status', '--porcelain').trim()).toBe('?? "c new.txt"')

      const empty = await host.invoke('git', 'commit', { argv: ['-m', 'again'] }, caller(repo))
      expect(empty).toMatchObject({ ok: false, error: 'git-failed' })
      expect(empty.ok ? '' : empty.message).toMatch(/nothing/)
    })

    it('lists the files of a commit and opens one as parent vs commit', async () => {
      const head = git('rev-parse', 'HEAD').trim()
      const files = await panelCall('commitFiles', { sha: head })
      expect(files).toMatchObject({
        ok: true,
        data: {
          commit: { sha: head, subject: 'stage b' },
          files: [{ path: 'sub/b.txt', code: 'M' }],
        },
      })
      openDiffIn.mockClear()
      const opened = await panelCall('openCommitFile', { sha: head, path: 'sub/b.txt' })
      expect(opened.ok).toBe(true)
      expect(openDiffIn).toHaveBeenCalledWith({
        extId: 'git',
        workspaceId: 's1',
        title: `b.txt (${head.slice(0, 7)})`,
        original: 'bee\n',
        modified: 'bee staged\n',
        path: join(repo, 'sub', 'b.txt'),
      })
      const initial = git('rev-list', '--max-parents=0', 'HEAD').trim()
      const first = await panelCall('commitFiles', { sha: initial })
      expect(first.ok && (first.data as { files: unknown[] }).files).toEqual([
        { path: 'a.txt', code: 'A' },
        { path: 'sub/b.txt', code: 'A' },
      ])
      expect(await panelCall('commitFiles', { sha: '--all' })).toMatchObject({
        ok: false,
        error: 'invalid-args',
      })
    })
  })

  describe('graph', () => {
    interface GraphResult {
      scope: { kind: string; refs?: string[] }
      includesHead: boolean
      more: boolean
      branch: { head: string; upstream: string | null; ahead: number }
      counts: { untracked: number }
      branches: { ref: string; current: boolean }[]
      commits: {
        sha: string
        subject: string
        parents: string[]
        refs: { kind: string; name: string; current?: boolean }[]
      }[]
    }
    let clock = Math.floor(Date.now() / 1000) + 100
    const dated = (...args: string[]): string => {
      clock += 10
      return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: `@${clock} +0000`,
          GIT_COMMITTER_DATE: `@${clock} +0000`,
        },
      })
    }
    const graph = async (args: unknown = {}): Promise<GraphResult> => {
      const res = await panelCall('graph', args)
      if (!res.ok) throw new Error(JSON.stringify(res))
      return res.data as GraphResult
    }
    const subjects = (g: GraphResult): string[] => g.commits.map((c) => c.subject)
    const stored = (): unknown =>
      broadcasts.filter((b) => b.channel === 'extensions:settings-stored').at(-1)?.payload
    const viewFile = (): Record<string, unknown> =>
      JSON.parse(readFileSync(join(dir, 'ext-data', 'git', 'view.json'), 'utf8'))

    beforeAll(() => {
      const pushed = git('rev-parse', 'HEAD').trim()
      const init = git('rev-list', '--max-parents=0', 'HEAD').trim()
      git('checkout', '-q', '-b', 'feature')
      writeFileSync(join(repo, 'f.txt'), 'feature\n')
      git('add', 'f.txt')
      dated('commit', '-q', '-m', 'f1')
      git('checkout', '-q', 'main')
      writeFileSync(join(repo, 'a.txt'), 'one\nmain\n')
      git('add', 'a.txt')
      dated('commit', '-q', '-m', 'm1')
      dated('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature')
      git('checkout', '-q', '-b', 'side', init)
      writeFileSync(join(repo, 's.txt'), 'side\n')
      git('add', 's.txt')
      dated('commit', '-q', '-m', 's1')
      git('checkout', '-q', 'main')
      git('remote', 'add', 'origin', join(dir, 'no-remote.git'))
      git('update-ref', 'refs/remotes/origin/main', pushed)
      git('branch', '-q', '--set-upstream-to=origin/main', 'main')
    })

    it('shows only the current branch by default, merges with both parents, and the dirty tree', async () => {
      const g = await graph()
      expect(g.scope).toEqual({ kind: 'current' })
      expect(g.includesHead).toBe(true)
      expect(subjects(g)).toEqual(['merge feature', 'm1', 'f1', 'stage b', 'init'])
      expect(g.commits[0].parents).toHaveLength(2)
      expect(g.commits[0].parents[1]).toBe(g.commits[2].sha)
      expect(g.commits[0].refs).toContainEqual({ kind: 'branch', name: 'main', current: true })
      expect(g.commits[2].refs).toContainEqual({ kind: 'branch', name: 'feature' })
      expect(g.commits[3].refs).toContainEqual({ kind: 'remote', name: 'origin/main' })
      expect(g.branch).toMatchObject({ head: 'main', upstream: 'origin/main', ahead: 3 })
      expect(g.counts.untracked).toBe(1)
      expect(g.branches.find((b) => b.current)?.ref).toBe('refs/heads/main')
    })

    it('pages the history with a limit and says when there is more', async () => {
      const g = await graph({ limit: 2 })
      expect(subjects(g)).toEqual(['merge feature', 'm1'])
      expect(g.more).toBe(true)
      expect((await graph({ limit: 50 })).more).toBe(false)
    })

    it('shows every local and remote branch for all, and stores it as the graphScope setting', async () => {
      expect(await panelCall('setScope', { scope: { kind: 'all' } })).toMatchObject({ ok: true })
      expect(stored()).toEqual({ extId: 'git', stored: { graphScope: 'all' } })
      const g = await graph()
      expect(g.scope).toEqual({ kind: 'all' })
      expect(subjects(g)).toContain('s1')
      expect(subjects(g)).toHaveLength(6)
    })

    it('remembers chosen branches for the repository without changing the setting', async () => {
      const chosen = await panelCall('setScope', {
        scope: { kind: 'chosen', refs: ['refs/heads/side'] },
      })
      expect(chosen.ok).toBe(true)
      const g = await graph()
      expect(g.scope).toEqual({ kind: 'chosen', refs: ['refs/heads/side'] })
      expect(g.includesHead).toBe(false)
      expect(subjects(g)).toEqual(['s1', 'init'])
      expect(viewFile()).toEqual({ chosen: { [repo]: ['refs/heads/side'] } })
      expect(stored()).toEqual({ extId: 'git', stored: { graphScope: 'all' } })
    })

    it('refuses scopes that are not branch refs', async () => {
      expect(
        await panelCall('setScope', { scope: { kind: 'chosen', refs: ['--output=/tmp/x'] } }),
      ).toMatchObject({ ok: false, error: 'invalid-args' })
    })

    it('goes back to the setting when the panel picks current, and follows Settings changes', async () => {
      await panelCall('setScope', { scope: { kind: 'current' } })
      expect(viewFile()).toEqual({ chosen: {} })
      expect(stored()).toEqual({ extId: 'git', stored: { graphScope: 'current' } })
      expect((await graph()).scope).toEqual({ kind: 'current' })

      expect(host.setSetting('git', 'graphScope', 'all').ok).toBe(true)
      expect((await eventually(graph, (g) => g.scope.kind === 'all')).scope).toEqual({
        kind: 'all',
      })
      expect(host.setSetting('git', 'graphScope', null).ok).toBe(true)
      await eventually(graph, (g) => g.scope.kind === 'current')
    })

    it('keeps the changes view in the changesView setting, from the panel and from Settings', async () => {
      expect(await panelCall('view', {})).toMatchObject({ ok: true, data: { changesView: 'list' } })
      expect(await panelCall('setChangesView', { view: 'tree' })).toMatchObject({ ok: true })
      expect(stored()).toEqual({ extId: 'git', stored: { changesView: 'tree' } })
      expect(await panelCall('view', {})).toMatchObject({ data: { changesView: 'tree' } })
      expect(host.setSetting('git', 'changesView', 'list').ok).toBe(true)
      const view = (): Promise<ExtensionResult> => panelCall('view', {})
      await eventually(
        view,
        (r) => r.ok && (r.data as { changesView: string }).changesView === 'list',
      )
      expect(await panelCall('setChangesView', { view: 'grid' })).toMatchObject({
        ok: false,
        error: 'invalid-args',
      })
    })
  })
})
