import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { paneGit } from './paneGit'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-pane-git-')))
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
writeFileSync(join(dir, 'a.txt'), 'x\n')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('git facts for pane status', () => {
  it('reads them for an ordinary local pane', async () => {
    const git = paneGit({ isRemote: () => false, isSandboxed: () => false })
    expect(await git('p', dir)).toMatchObject({ branch: 'main', changed: 1 })
  })

  it('runs no git at all for a sandboxed pane or a remote one', async () => {
    const marker = join(dir, 'marker')
    execFileSync('git', ['config', 'core.fsmonitor', `touch ${marker}`], { cwd: dir })
    expect(
      await paneGit({ isRemote: () => false, isSandboxed: () => true })('p', dir),
    ).toBeUndefined()
    expect(
      await paneGit({ isRemote: () => true, isSandboxed: () => false })('p', dir),
    ).toBeUndefined()
    expect(() => execFileSync('test', ['-e', marker])).toThrow()
  })
})
