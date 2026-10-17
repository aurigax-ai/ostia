import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hasFullDiskAccess,
  keptProbeScript,
  parseKeptProbe,
  readFoldersInKeptShells,
  readFoldersInMain,
} from './folderProbe'

const run = promisify(execFile)
const isRoot = process.getuid?.() === 0

async function sh(script: string): Promise<boolean> {
  await run('/bin/sh', ['-c', script])
  return true
}

describe('folder probes', () => {
  let root: string
  let home: string
  let dir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "folder-probe-it's #1-"))
    home = join(root, 'home')
    dir = join(root, 'kept')
    mkdirSync(join(home, 'Downloads'), { recursive: true })
    writeFileSync(join(home, 'Downloads', 'a.txt'), 'secret contents')
    mkdirSync(dir, { mode: 0o700 })
  })

  afterEach(() => {
    try {
      chmodSync(join(home, 'Desktop'), 0o700)
    } catch {}
    rmSync(root, { recursive: true, force: true })
  })

  it('parses the kept-shell report and counts only Operation not permitted as denied', () => {
    const text = [
      'Downloads\t1\tls: /u/Downloads: Operation not permitted ',
      'Documents\t0\t',
      'Desktop\t1\tls: /u/Desktop: No such file or directory ',
      'Library\t1\tls: /u/Library: Operation not permitted ',
      'Desktop-ish\tx\t',
      '',
    ].join('\n')
    expect(parseKeptProbe(text)).toEqual({ Downloads: 'denied', Documents: 'ok', Desktop: 'other' })
  })

  it.skipIf(isRoot)(
    'lists each folder from a shell and reports ok, Permission denied and missing apart',
    async () => {
      mkdirSync(join(home, 'Desktop'))
      chmodSync(join(home, 'Desktop'), 0)
      const reads = await readFoldersInKeptShells({ dir, home, runShell: sh })
      expect(reads).toEqual({ Downloads: 'ok', Documents: 'other', Desktop: 'other' })
      expect(readdirSync(dir)).toEqual([])
    },
  )

  it('writes the report under a temporary name and moves it into place', () => {
    const script = keptProbeScript('/u', '/k/out')
    expect(script.startsWith("umask 077; : > '/k/out.partial'; ")).toBe(true)
    expect(script.endsWith("; mv -f '/k/out.partial' '/k/out'")).toBe(true)
    expect(script.indexOf("'/k/out'")).toBe(script.lastIndexOf("'/k/out'"))
  })

  it('gives up when tmux cannot run the probe or it never reports', async () => {
    expect(await readFoldersInKeptShells({ dir, home, runShell: async () => false })).toBeNull()
    expect(
      await readFoldersInKeptShells({ dir, home, runShell: async () => true, waitMs: 100 }),
    ).toBeNull()
    expect(readdirSync(dir)).toEqual([])
  })

  it('reads the folders from Ostia itself without reading any file', async () => {
    expect(await readFoldersInMain(home)).toEqual({
      Downloads: 'ok',
      Documents: 'other',
      Desktop: 'other',
    })
  })

  it('tells Full Disk Access by whether a protected file opens', async () => {
    const file = join(root, 'db')
    writeFileSync(file, '')
    expect(await hasFullDiskAccess(file)).toBe(true)
    expect(await hasFullDiskAccess(join(root, 'missing'))).toBe(false)
  })
})
