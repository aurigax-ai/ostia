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
import { afterAll, describe, expect, it } from 'vitest'
import { commitDetail, graphLog, log } from './repo'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-git-log-hardening-')))
const repo = join(root, 'repo')
const mark = join(root, 'gpg-ran')
const env = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  }).trim()

afterAll(() => rmSync(root, { recursive: true, force: true }))

mkdirSync(repo)
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.txt'), 'one\n')
git(repo, 'add', '.')
const tree = git(repo, 'write-tree')
const signed = [
  `tree ${tree}`,
  'author t <a@b.c> 1767225600 +0000',
  'committer t <a@b.c> 1767225600 +0000',
  'gpgsig -----BEGIN PGP SIGNATURE-----',
  ' ',
  ' ZmFrZQ==',
  ' -----END PGP SIGNATURE-----',
  '',
  'signed',
  '',
].join('\n')
writeFileSync(join(root, 'commit.txt'), signed)
const sha = git(repo, 'hash-object', '-t', 'commit', '-w', join(root, 'commit.txt'))
git(repo, 'update-ref', 'refs/heads/main', sha)
const gpg = join(root, 'gpg.sh')
writeFileSync(gpg, `#!/bin/sh\ntouch "${mark}"\nexit 1\n`)
chmodSync(gpg, 0o755)
git(repo, 'config', 'log.showSignature', 'true')
git(repo, 'config', 'gpg.program', gpg)

describe('git log under a repository config that verifies signatures with its own program', () => {
  it('never runs gpg.program for the log, the graph or a commit detail', async () => {
    expect((await log(repo, 5)).map((c) => c.subject)).toEqual(['signed'])
    await graphLog(repo, [], 5)
    await commitDetail(repo, sha)
    expect(existsSync(mark)).toBe(false)
  })
})

describe('git read in a folder that holds a bare repository', () => {
  it('does not use a bare repository found in the folder', async () => {
    const bare = join(root, 'nested')
    mkdirSync(bare)
    git(bare, 'init', '-q', '--bare', '-b', 'main')
    git(repo, 'push', '-q', bare, 'main:main')
    expect(await log(bare, 5)).toEqual([])
  })
})
