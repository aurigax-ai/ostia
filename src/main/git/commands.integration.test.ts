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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { en, zhHant } from '../../shared/app/dict'
import { DEFAULT_GIT_SETTINGS, type GitSettings } from '../../shared/boards/git'
import type { ExtensionOpenDiffRequest } from '../../shared/extensions'
import { type DiscardPrompt, type GitCaller, GitCommands } from './commands'
import { ViewStateStore } from './viewState'

describe('git commands against a real repository', () => {
  let dir: string
  let repo: string
  let commands: GitCommands
  let settings: GitSettings = { ...DEFAULT_GIT_SETTINGS }
  let text = en.git
  const openDiff = vi.fn<(req: ExtensionOpenDiffRequest) => void>()
  const confirmDiscard = vi.fn<(prompt: DiscardPrompt) => Promise<boolean>>()
  const touched = vi.fn()

  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
  const from = (cwd: string = repo): GitCaller => ({ workspaceId: 's1', cwd })
  const panel: GitCaller = { workspaceId: 's1' }
  const staged = (): string => git('diff', '--cached', '--name-only').trim()

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-git-commands-')))
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
    commands = new GitCommands({
      settings: () => settings,
      text: () => text,
      cwdOf: async (workspaceId) => (workspaceId === 's1' ? join(repo, 'sub') : null),
      views: new ViewStateStore(join(dir, 'git-view.json')),
      openDiff,
      confirmDiscard,
      touched,
    })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    openDiff.mockReset()
    confirmDiscard.mockReset()
    touched.mockReset()
  })

  it('reports the branch and counts, and lists staged, unstaged and untracked changes', async () => {
    expect(await commands.status(from())).toMatchObject({
      ok: true,
      data: {
        root: repo,
        branch: { head: 'main' },
        counts: { staged: 1, unstaged: 1, untracked: 1 },
      },
    })
    const res = await commands.changes(panel)
    expect(res.ok && res.data.changes).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', area: 'unstaged', code: 'M' },
        { path: 'sub/b.txt', area: 'staged', code: 'M' },
        { path: 'c new.txt', area: 'untracked', code: '?' },
      ]),
    )
  })

  it('opens an unstaged diff with the index on the left and the working file on the right', async () => {
    expect(await commands.open(from(), 'a.txt')).toEqual({
      ok: true,
      data: { opened: 'a.txt', area: 'unstaged' },
    })
    expect(openDiff).toHaveBeenCalledWith({
      extId: 'git',
      workspaceId: 's1',
      title: 'a.txt (unstaged)',
      original: 'one\n',
      modified: 'one\ntwo\n',
      path: join(repo, 'a.txt'),
    })
  })

  it('resolves a relative path from the caller folder and an absolute one from the panel', async () => {
    await commands.open(from(join(repo, 'sub')), 'b.txt', 'staged')
    expect(openDiff.mock.calls[0][0]).toMatchObject({
      title: 'b.txt (staged)',
      original: 'bee\n',
      modified: 'bee staged\n',
    })
    await commands.open(panel, join(repo, 'c new.txt'), 'untracked')
    expect(openDiff.mock.calls[1][0]).toMatchObject({ original: '', modified: 'fresh\n' })
  })

  it('returns a unified patch, and says why when there is none', async () => {
    const diff = await commands.diff(from(), 'a.txt')
    expect(diff.ok && diff.data.patch).toContain('+two')
    expect(await commands.status(from(dir))).toMatchObject({ ok: false, error: 'not-a-repo' })
    expect(await commands.diff(from(), 'nope.txt')).toMatchObject({
      ok: false,
      error: 'not-changed',
    })
    expect(await commands.diff(from(), join(dir, 'outside.txt'))).toMatchObject({
      ok: false,
      error: 'not-changed',
    })
    expect(await commands.diff(from(), undefined)).toMatchObject({
      ok: false,
      error: 'invalid-args',
    })
  })

  it('shows a symlink as its target path instead of reading through it', async () => {
    writeFileSync(join(dir, 'secret.txt'), 'outside the repository\n')
    symlinkSync(join(dir, 'secret.txt'), join(repo, 'link'))
    try {
      await commands.open(from(), 'link')
      expect(openDiff.mock.calls[0][0].modified).toBe(join(dir, 'secret.txt'))
    } finally {
      rmSync(join(repo, 'link'))
    }
  })

  it('lists recent commits and blames each line, as data and as text', async () => {
    const log = await commands.log(from(), undefined, true)
    expect(log.ok && log.data.commits.map((c) => c.subject)).toEqual(['init'])
    expect(log.ok && log.text).toMatch(/^[0-9a-f]{7} \d{4}-\d{2}-\d{2} Test {2}init$/)
    const blame = await commands.blame(from(), 'a.txt', true)
    expect(blame.ok && blame.data.lines.map((l) => l.text)).toEqual(['one', 'two'])
    expect(blame.ok && blame.text?.split('\n')[1]).toBe('2 Not committed yet\ttwo')
    text = zhHant.git
    const zh = await commands.blame(from(), 'a.txt', true)
    text = en.git
    expect(zh.ok && zh.text?.split('\n')[1]).toBe('2 尚未提交\ttwo')
    expect(await commands.blame(from(), undefined, false)).toMatchObject({
      ok: false,
      error: 'invalid-args',
    })
  })

  it('stages and unstages paths, from another folder too, and everything with all', async () => {
    expect(await commands.changeIndex(from(), 'stage', { paths: [], all: false })).toMatchObject({
      ok: false,
      error: 'invalid-args',
    })
    const res = await commands.changeIndex(from(), 'stage', { paths: ['a.txt'], all: false })
    expect(res).toMatchObject({ ok: true, data: { staged: ['a.txt'], counts: { staged: 2 } } })
    expect(touched).toHaveBeenCalledTimes(1)
    await commands.changeIndex(from(join(repo, 'sub')), 'unstage', {
      paths: ['../a.txt'],
      all: false,
    })
    expect(staged()).toBe('sub/b.txt')
    await commands.changeIndex(from(), 'stage', { paths: [], all: true })
    expect(staged().split('\n')).toEqual(['a.txt', 'c new.txt', 'sub/b.txt'])
    await commands.changeIndex(from(), 'unstage', { paths: [], all: true })
    expect(staged()).toBe('')
    await commands.changeIndex(panel, 'stage', { paths: [join(repo, 'sub', 'b.txt')], all: false })
    expect(staged()).toBe('sub/b.txt')
  })

  it('treats a path that looks like a pathspec or an option as a literal file name', async () => {
    writeFileSync(join(repo, '*.txt'), 'star\n')
    writeFileSync(join(repo, ':(top)x'), 'magic\n')
    try {
      await commands.changeIndex(from(), 'stage', { paths: ['*.txt'], all: false })
      expect(staged().split('\n').sort()).toEqual(['*.txt', 'sub/b.txt'])
      await commands.changeIndex(from(), 'stage', { paths: [':(top)x'], all: false })
      expect(staged().split('\n')).toContain(':(top)x')
      await commands.changeIndex(from(), 'unstage', { paths: ['*.txt', ':(top)x'], all: false })
      expect(staged()).toBe('sub/b.txt')
    } finally {
      rmSync(join(repo, '*.txt'))
      rmSync(join(repo, ':(top)x'))
    }
  })

  it('discards only after the human confirms, and only what was asked', async () => {
    confirmDiscard.mockResolvedValueOnce(false)
    const denied = await commands.discard(panel, { paths: [join(repo, 'a.txt')], all: false })
    expect(denied).toMatchObject({ ok: false, error: 'cancelled' })
    expect(confirmDiscard).toHaveBeenCalledTimes(1)
    expect(confirmDiscard.mock.calls[0][0]).toMatchObject({
      title: 'Discard changes',
      message: 'Discard the changes to 1 file? This cannot be undone.',
      confirmLabel: 'Discard',
      cancelLabel: 'Cancel',
    })
    expect(confirmDiscard.mock.calls[0][0].detail).toContain('a.txt')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(touched).not.toHaveBeenCalled()

    confirmDiscard.mockResolvedValueOnce(true)
    const done = await commands.discard(panel, { paths: [join(repo, 'a.txt')], all: false })
    expect(done).toMatchObject({ ok: true, data: { discarded: ['a.txt'] } })
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(repo, 'c new.txt'))).toBe(true)
    expect(staged()).toBe('sub/b.txt')

    const nothing = await commands.discard(panel, { paths: [join(repo, 'a.txt')], all: false })
    expect(nothing).toMatchObject({ ok: false, error: 'not-changed' })
    expect(confirmDiscard).toHaveBeenCalledTimes(2)
  })

  it('commits only the staged changes and reports what git says when there is nothing', async () => {
    expect(await commands.commit(from(), '  ')).toMatchObject({ ok: false, error: 'invalid-args' })
    const res = await commands.commit(from(), 'stage b')
    expect(res).toMatchObject({ ok: true, data: { subject: 'stage b' } })
    expect(git('log', '-1', '--format=%s').trim()).toBe('stage b')
    expect(git('status', '--porcelain')).toContain('?? "c new.txt"')
    expect(await commands.commit(from(), 'again')).toMatchObject({ ok: false, error: 'git-failed' })
  })

  it('lists the files of a commit and opens one as parent against commit', async () => {
    const head = git('rev-parse', 'HEAD').trim()
    const files = await commands.commitFiles(panel, head)
    expect(files.ok && files.data.files).toEqual([{ path: 'sub/b.txt', code: 'M' }])
    await commands.openCommitFile(panel, head, 'sub/b.txt')
    expect(openDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        title: `b.txt (${head.slice(0, 7)})`,
        original: 'bee\n',
        modified: 'bee staged\n',
      }),
    )
    expect(await commands.commitFiles(panel, '--all')).toMatchObject({
      ok: false,
      error: 'invalid-args',
    })
    expect(await commands.commitFiles(panel, 'deadbeef')).toMatchObject({
      ok: false,
      error: 'unknown-commit',
    })
  })

  it('graphs the current branch by default, every branch for all, and chosen branches per repository', async () => {
    git('checkout', '-q', '-b', 'side')
    writeFileSync(join(repo, 's.txt'), 'side\n')
    git('add', 's.txt')
    git('commit', '-q', '-m', 's1')
    git('checkout', '-q', 'main')
    const subjects = async (): Promise<string[]> => {
      const res = await commands.graph(panel, 50)
      if (!res.ok) throw new Error(res.error)
      return res.data.commits.map((c) => c.subject)
    }
    expect(await subjects()).toEqual(['stage b', 'init'])
    const paged = await commands.graph(panel, 1)
    expect(paged.ok && [paged.data.commits.length, paged.data.more]).toEqual([1, true])

    settings = { ...settings, graphScope: 'all' }
    expect((await subjects()).sort()).toEqual(['init', 's1', 'stage b'])

    await commands.setScope(panel, { kind: 'chosen', refs: ['refs/heads/side'] })
    const chosen = await commands.graph(panel, 50)
    expect(chosen.ok && chosen.data.scope).toEqual({ kind: 'chosen', refs: ['refs/heads/side'] })
    expect(chosen.ok && chosen.data.includesHead).toBe(false)
    expect(await subjects()).toEqual(['s1', 'stage b', 'init'])
    expect(JSON.parse(readFileSync(join(dir, 'git-view.json'), 'utf8'))).toEqual({
      chosen: { [repo]: ['refs/heads/side'] },
    })

    await commands.setScope(panel, { kind: 'current' })
    settings = { ...settings, graphScope: 'current' }
    expect(await subjects()).toEqual(['stage b', 'init'])
  })

  it('lists the files a merge brought in against its first parent', async () => {
    git('checkout', '-q', '-b', 'topic')
    writeFileSync(join(repo, 't.txt'), 'topic\n')
    git('add', 't.txt')
    git('commit', '-q', '-m', 'topic work')
    git('checkout', '-q', 'main')
    writeFileSync(join(repo, 'm.txt'), 'main\n')
    git('add', 'm.txt')
    git('commit', '-q', '-m', 'main work')
    git('merge', '-q', '--no-ff', '-m', 'merge topic', 'topic')
    const merge = git('rev-parse', 'HEAD').trim()

    const res = await commands.commitFiles(panel, merge)

    expect(res.ok && res.data.parent).toBe(git('rev-parse', 'HEAD^1').trim())
    expect(res.ok && res.data.files).toEqual([{ path: 't.txt', code: 'A' }])
  })
})
