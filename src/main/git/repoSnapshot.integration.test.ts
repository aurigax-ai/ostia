import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { repoSnapshot } from './repoSnapshot'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-snapshot-')))
const repo = join(root, 'My Repo')

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim()

afterAll(() => rmSync(root, { recursive: true, force: true }))

mkdirSync(repo)
git('init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.txt'), 'one\n')
git('add', '.')
git('commit', '-q', '-m', 'first')

describe('repoSnapshot', () => {
  it('RMT-C1 names the clean repository by its slug and root commit and records HEAD', async () => {
    const snapshot = await repoSnapshot(repo)
    expect(snapshot).toMatchObject({ ok: true, root: repo })
    if (!snapshot.ok) return
    expect(snapshot.repo.head).toBe(git('rev-parse', 'HEAD'))
    expect(snapshot.repo.name).toBe('My-Repo')
    expect(snapshot.repo.id).toBe(
      `My-Repo-${git('rev-list', '--max-parents=0', 'HEAD').slice(0, 12)}`,
    )
  })

  it('RMT-C2 refuses a tree with an uncommitted change and asks to commit or stash', async () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    const snapshot = await repoSnapshot(repo)
    expect(snapshot).toMatchObject({ ok: false, error: 'dirty' })
    expect(snapshot.ok ? '' : snapshot.message).toContain('commit or stash first')
    git('checkout', '--', 'a.txt')
  })

  it('RMT-C3 refuses a tree with an untracked file', async () => {
    writeFileSync(join(repo, 'new.txt'), 'x\n')
    expect(await repoSnapshot(repo)).toMatchObject({ ok: false, error: 'dirty' })
    rmSync(join(repo, 'new.txt'))
  })

  it('RMT-C4 refuses a folder that is not a repository', async () => {
    expect(await repoSnapshot(root)).toMatchObject({ ok: false, error: 'not-a-repo' })
  })
})
