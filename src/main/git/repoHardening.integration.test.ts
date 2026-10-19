import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { blame, commit, discard, lineChanges, readStatus, unifiedPatch, worktreeKey } from './repo'

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

  it('runs no program of the submodule for a status, a line count or a patch', async () => {
    const status = await readStatus(outer)
    await lineChanges(outer, [])
    for (const change of status.changes) await unifiedPatch(outer, change)
    for (const name of ['subclean', 'subprocess', 'subfsmonitor']) {
      expect(existsSync(join(marks, name))).toBe(false)
    }
  })
})
