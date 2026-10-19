import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { worktreeKey } from './repo'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-worktree-key-')))
const repo = join(root, 'repo')
const linked = join(root, 'linked')
const plain = join(root, 'plain')

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  })

mkdirSync(join(repo, 'src'), { recursive: true })
mkdirSync(plain)
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.txt'), 'a')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'one')
git(repo, 'worktree', 'add', '-q', linked, '-b', 'other')

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('worktreeKey', () => {
  it('is the same for the top of a worktree and a folder inside it', async () => {
    const top = await worktreeKey(repo)
    expect(top).toBeDefined()
    expect(await worktreeKey(join(repo, 'src'))).toBe(top)
  })

  it('differs between the main worktree and a linked worktree of the same repository', async () => {
    const main = await worktreeKey(repo)
    const other = await worktreeKey(linked)
    expect(other).toBeDefined()
    expect(other).not.toBe(main)
  })

  it('is undefined outside a git repository and for a folder that does not exist', async () => {
    expect(await worktreeKey(plain)).toBeUndefined()
    expect(await worktreeKey(join(root, 'missing'))).toBeUndefined()
  })
})
