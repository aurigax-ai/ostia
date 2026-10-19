import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  blame,
  commit,
  diffSides,
  discard,
  lineChanges,
  readStatus,
  stage,
  unifiedPatch,
  unstage,
  worktreeKey,
} from './repo'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-git-hardening-')))
const repo = join(root, 'repo')
const marks = join(root, 'marks')
const hooks = join(root, 'hooks')

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
    cwd: repo,
    stdio: 'ignore',
  })

function program(name: string): string {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\ntouch "${join(marks, name)}"\nexit 1\n`)
  chmodSync(path, 0o755)
  return path
}

beforeEach(() => {
  rmSync(marks, { recursive: true, force: true })
  mkdirSync(marks, { recursive: true })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

mkdirSync(repo)
mkdirSync(hooks)
git('init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.txt'), 'one\n')
writeFileSync(join(repo, 'blob.evil'), 'data\n')
writeFileSync(join(repo, '.gitattributes'), '*.evil diff=evil filter=evil\n')
writeFileSync(join(repo, 'info.cfg'), 'data\n')
git('add', '.')
git('commit', '-q', '-m', 'first')
for (const hook of ['pre-commit', 'post-checkout']) {
  const path = join(hooks, hook)
  writeFileSync(path, `#!/bin/sh\ntouch "${join(marks, hook)}"\n`)
  chmodSync(path, 0o755)
}
git('config', 'core.fsmonitor', program('fsmonitor'))
git('config', 'filter.evil.clean', program('clean'))
git('config', 'filter.evil.smudge', program('smudge'))
git('config', 'filter.viainfo.clean', program('infoclean'))
writeFileSync(join(repo, '.git', 'info', 'attributes'), 'info.cfg filter=viainfo\n')
git('config', 'diff.evil.textconv', program('textconv'))
git('config', 'diff.external', program('external'))
git('config', 'core.hooksPath', hooks)
writeFileSync(join(repo, 'a.txt'), 'two\n')
writeFileSync(join(repo, 'blob.evil'), 'changed\n')
writeFileSync(join(repo, 'info.cfg'), 'changed\n')

describe('git reads under a repository config a sandboxed agent could have written', () => {
  it('never runs core.fsmonitor for a status, a key or a line count', async () => {
    await readStatus(repo)
    await worktreeKey(repo)
    await lineChanges(repo, [])
    expect(existsSync(join(marks, 'fsmonitor'))).toBe(false)
  })

  it('never runs a clean or smudge filter named by the repository config, from .gitattributes or .git/info/attributes', async () => {
    await readStatus(repo)
    await lineChanges(repo, [])
    expect(existsSync(join(marks, 'clean'))).toBe(false)
    expect(existsSync(join(marks, 'infoclean'))).toBe(false)
    expect(existsSync(join(marks, 'smudge'))).toBe(false)
  })

  it('never runs a textconv or external diff driver for a patch, a line count or a blame', async () => {
    const [change] = (await readStatus(repo)).changes.filter((c) => c.path === 'blob.evil')
    await unifiedPatch(repo, change)
    await lineChanges(repo, [])
    await blame(repo, 'blob.evil')
    expect(existsSync(join(marks, 'textconv'))).toBe(false)
    expect(existsSync(join(marks, 'external'))).toBe(false)
  })

  it('does not run a repository hook when the panel discards a change', async () => {
    const [change] = (await readStatus(repo)).changes.filter((c) => c.path === 'a.txt')
    await discard(repo, [change])
    expect(existsSync(join(marks, 'post-checkout'))).toBe(false)
  })

  it('still runs the human’s own pre-commit hook when the panel commits', async () => {
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    git('add', 'c.txt')
    rmSync(join(marks, 'fsmonitor'), { force: true })
    await commit(repo, 'from the panel')
    expect(existsSync(join(marks, 'pre-commit'))).toBe(true)
    expect(existsSync(join(marks, 'fsmonitor'))).toBe(false)
  })
})

describe('git reads of a repository with a submodule whose own config names programs', () => {
  const outer = join(root, 'outer')
  const inner = join(root, 'inner')

  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.email=a@b.c', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args],
      { cwd, stdio: 'ignore' },
    )

  mkdirSync(inner)
  gitIn(inner, 'init', '-q', '-b', 'main')
  writeFileSync(join(inner, 's.evil'), 'one\n')
  writeFileSync(join(inner, 'p.proc'), 'one\n')
  writeFileSync(join(inner, '.gitattributes'), '*.evil filter=sub\n*.proc filter=subp\n')
  gitIn(inner, 'add', '.')
  gitIn(inner, 'commit', '-q', '-m', 'inner')
  mkdirSync(outer)
  gitIn(outer, 'init', '-q', '-b', 'main')
  gitIn(outer, 'submodule', 'add', '-q', inner, 'sub')
  gitIn(outer, 'commit', '-q', '-m', 'outer')
  const subGit = join(outer, 'sub')
  gitIn(subGit, 'config', 'filter.sub.clean', program('subclean'))
  gitIn(subGit, 'config', 'filter.subp.process', program('subprocess'))
  gitIn(subGit, 'config', 'core.fsmonitor', program('subfsmonitor'))
  writeFileSync(join(subGit, 's.evil'), 'two\n')
  writeFileSync(join(subGit, 'p.proc'), 'two\n')

  const noMarks = () => {
    for (const name of ['subclean', 'subprocess', 'subfsmonitor']) {
      expect(existsSync(join(marks, name))).toBe(false)
    }
  }

  it('runs no program of the submodule for a status, a line count or a patch', async () => {
    const status = await readStatus(outer)
    await lineChanges(outer, [])
    for (const change of status.changes) await unifiedPatch(outer, change)
    noMarks()
  })

  it('lists what changed inside the submodule under its path', async () => {
    const status = await readStatus(outer)
    expect(status.changes.map((c) => `${c.area}:${c.path}`).sort()).toEqual([
      'unstaged:sub/p.proc',
      'unstaged:sub/s.evil',
    ])
    noMarks()
  })

  it('diffs, stages, unstages and discards a path inside the submodule in the submodule', async () => {
    const [change] = (await readStatus(outer)).changes.filter((c) => c.path === 'sub/s.evil')
    expect(await diffSides(outer, change)).toEqual({ original: 'one\n', modified: 'two\n' })
    expect(await unifiedPatch(outer, change)).toContain('+two')
    await stage(outer, ['sub/s.evil'])
    expect(
      execFileSync('git', ['-c', 'core.fsmonitor=false', 'diff', '--cached', '--name-only'], {
        cwd: subGit,
        encoding: 'utf8',
      }),
    ).toBe('s.evil\n')
    await unstage(outer, ['sub/s.evil'], true)
    expect(
      execFileSync('git', ['-c', 'core.fsmonitor=false', 'diff', '--cached', '--name-only'], {
        cwd: subGit,
        encoding: 'utf8',
      }),
    ).toBe('')
    await discard(outer, [change])
    expect(
      execFileSync('git', ['-c', 'core.fsmonitor=false', 'show', ':s.evil'], {
        cwd: subGit,
        encoding: 'utf8',
      }),
    ).toBe('one\n')
    noMarks()
  })

  it('does not follow a submodule path that leads outside the repository', async () => {
    const other = join(root, 'other')
    mkdirSync(other)
    gitIn(other, 'init', '-q', '-b', 'main')
    writeFileSync(join(other, 'secret.txt'), 'x\n')
    const outside = join(root, 'outside-link')
    mkdirSync(outside)
    gitIn(outside, 'init', '-q', '-b', 'main')
    const sha = execFileSync('git', ['hash-object', '-t', 'blob', '--stdin'], {
      cwd: outside,
      input: 'x',
      encoding: 'utf8',
    }).trim()
    gitIn(outside, 'update-index', '--add', '--cacheinfo', `160000,${sha},link`)
    symlinkSync(other, join(outside, 'link'))
    const status = await readStatus(outside)
    expect(status.changes.some((c) => c.path.includes('secret.txt'))).toBe(false)
  })
})

describe('git reads that could start more git, in a submodule or from a promisor remote', () => {
  const base = join(root, 'extra')
  const ownerRepo = join(base, 'owner')
  const subSource = join(base, 'subsource')

  const gitAt = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.email=a@b.c',
        '-c',
        'user.name=t',
        '-c',
        'protocol.file.allow=always',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      { cwd, stdio: 'ignore' },
    )

  mkdirSync(subSource, { recursive: true })
  gitAt(subSource, 'init', '-q', '-b', 'main')
  writeFileSync(join(subSource, 'f.txt'), 'one\n')
  gitAt(subSource, 'add', '.')
  gitAt(subSource, 'commit', '-q', '-m', 'one')
  mkdirSync(ownerRepo, { recursive: true })
  gitAt(ownerRepo, 'init', '-q', '-b', 'main')
  gitAt(ownerRepo, 'submodule', 'add', '-q', subSource, 'sub')
  gitAt(ownerRepo, 'commit', '-q', '-m', 'owner')
  const subDir = join(ownerRepo, 'sub')
  writeFileSync(join(subDir, 'f.txt'), 'two\n')
  gitAt(subDir, 'commit', '-q', '-a', '-m', 'two')
  gitAt(subDir, 'config', 'diff.external', program('subexternal'))
  gitAt(subDir, 'config', 'core.pager', program('subpager'))
  gitAt(ownerRepo, 'config', 'diff.submodule', 'diff')
  gitAt(ownerRepo, 'config', 'submodule.recurse', 'true')

  it('does not open a submodule diff when the repository asks for one', async () => {
    const status = await readStatus(ownerRepo)
    const moved = status.changes.filter((c) => c.path === 'sub')
    for (const change of moved) await unifiedPatch(ownerRepo, change)
    await lineChanges(ownerRepo, [])
    expect(existsSync(join(marks, 'subexternal'))).toBe(false)
  })

  it('does not recurse into submodules when the repository asks for it', async () => {
    const before = execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], {
      cwd: subDir,
      encoding: 'utf8',
    })
    writeFileSync(join(ownerRepo, 'x.txt'), 'x\n')
    await stage(ownerRepo, ['x.txt'])
    await unstage(ownerRepo, ['x.txt'], true)
    await discard(ownerRepo, [{ path: 'sub', area: 'unstaged', code: 'M' }])
    const after = execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], {
      cwd: subDir,
      encoding: 'utf8',
    })
    expect(after).toBe(before)
  })

  it('never fetches from a promisor remote to find a missing object', async () => {
    const lazy = join(base, 'lazy')
    mkdirSync(lazy, { recursive: true })
    gitAt(lazy, 'init', '-q', '-b', 'main')
    writeFileSync(join(lazy, 'a.txt'), 'content\n')
    gitAt(lazy, 'add', '.')
    gitAt(lazy, 'commit', '-q', '-m', 'a')
    const sha = execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', ':a.txt'], {
      cwd: lazy,
      encoding: 'utf8',
    }).trim()
    gitAt(lazy, 'config', 'extensions.partialClone', 'origin')
    gitAt(lazy, 'config', 'remote.origin.promisor', 'true')
    gitAt(lazy, 'config', 'remote.origin.url', 'ssh://example.invalid/repo')
    gitAt(lazy, 'config', 'core.sshCommand', program('lazyssh'))
    rmSync(join(lazy, '.git', 'objects', sha.slice(0, 2), sha.slice(2)), { force: true })
    writeFileSync(join(lazy, 'a.txt'), 'changed\n')
    const [change] = (await readStatus(lazy)).changes
    await diffSides(lazy, change).catch(() => undefined)
    await unifiedPatch(lazy, change).catch(() => undefined)
    expect(existsSync(join(marks, 'lazyssh'))).toBe(false)
  })
})
