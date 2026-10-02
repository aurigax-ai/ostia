import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SIDE_BYTES, lineChanges } from './repo'

describe('lineChanges', () => {
  let root: string

  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pine-line-changes-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(root, 'tracked.txt'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('counts an untracked file only when it is a regular text file within the size cap', async () => {
    writeFileSync(join(root, 'three.txt'), 'a\nb\nc\n')
    writeFileSync(join(root, 'binary.bin'), Buffer.from([1, 0, 2, 10, 3, 10]))
    writeFileSync(join(root, 'huge.txt'), 'a\n'.repeat(MAX_SIDE_BYTES / 2 + 1))
    writeFileSync(join(root, 'edge.txt'), 'a\n'.repeat(MAX_SIDE_BYTES / 2))
    symlinkSync(join(root, 'tracked.txt'), join(root, 'link.txt'))
    const names = ['three.txt', 'binary.bin', 'huge.txt', 'edge.txt', 'link.txt']

    expect(await lineChanges(root, names)).toEqual({
      files: names.length,
      added: 3 + MAX_SIDE_BYTES / 2,
      removed: 0,
    })
  })

  it('adds untracked lines to the tracked diff against HEAD', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'one\ntwo\n')
    writeFileSync(join(root, 'new.txt'), 'x\ny\n')
    expect(await lineChanges(root, ['new.txt'])).toEqual({ files: 2, added: 3, removed: 0 })
  })

  it('counts at most the first 500 untracked files and still lists the rest', async () => {
    const names = Array.from({ length: 501 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`)
    for (const name of names) writeFileSync(join(root, name), 'x\n')
    expect(await lineChanges(root, names)).toEqual({ files: 501, added: 500, removed: 0 })
    expect(await lineChanges(root, names.slice(0, 500))).toEqual({
      files: 500,
      added: 500,
      removed: 0,
    })
  })
})
