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
  sweepKeptProbes,
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
      chmodSync(join(home, 'Documents'), 0o700)
    } catch {}
    rmSync(root, { recursive: true, force: true })
  })

  it('parses the kept-shell report and counts only Operation not permitted as denied', () => {
    const text = [
      'Downloads\t1\tls: /u/Downloads: Operation not permitted ',
      'Documents\t1\tfind: /u/Documents: No such file or directory ',
      'Desktop\t1\tfind: /u/Desktop: Operation not permitted ',
      'Documents-ish\tx\t',
      '',
    ].join('\n')
    expect(parseKeptProbe(text)).toEqual({ Downloads: 'denied', Documents: 'other' })
  })

  it.skipIf(isRoot)(
    'lists each folder from a shell and tells ok from Permission denied',
    async () => {
      mkdirSync(join(home, 'Documents'))
      chmodSync(join(home, 'Documents'), 0)
      const reads = await readFoldersInKeptShells({ dir, home, runShell: sh })
      expect(reads).toEqual({ Downloads: 'ok', Documents: 'other' })
      expect(readdirSync(dir)).toEqual([])
    },
  )

  it('writes the report under a temporary name and moves it into place', () => {
    const script = keptProbeScript('/u', '/k/p')
    expect(script.startsWith("umask 077; [ -d '/k/p' ] || exit 0; : > '/k/p/report.partial'")).toBe(
      true,
    )
    expect(script.endsWith("; [ -d '/k/p' ] && mv -f '/k/p/report.partial' '/k/p/report'")).toBe(
      true,
    )
    expect(script.indexOf("'/k/p/report'")).toBe(script.lastIndexOf("'/k/p/report'"))
    expect(script).toContain("/usr/bin/find '/u/Downloads' -mindepth 1 -maxdepth 1 -print -quit")
    expect(script).not.toContain('/bin/ls')
  })

  it('never reads Desktop, from the kept shells or from Ostia', async () => {
    mkdirSync(join(home, 'Desktop'))
    expect(keptProbeScript(home, join(dir, 'p'))).not.toContain('Desktop')
    expect(Object.keys(await readFoldersInMain(home))).toEqual(['Downloads', 'Documents'])
  })

  it('gives up when tmux cannot run the probe or it never reports', async () => {
    expect(await readFoldersInKeptShells({ dir, home, runShell: async () => false })).toBeNull()
    expect(
      await readFoldersInKeptShells({ dir, home, runShell: async () => true, waitMs: 100 }),
    ).toBeNull()
    expect(readdirSync(dir)).toEqual([])
  })

  it('leaves nothing behind when the shell runs the probe after Ostia gave up on it', async () => {
    let late = ''
    const reads = await readFoldersInKeptShells({
      dir,
      home,
      runShell: async (script) => {
        late = script
        return true
      },
      waitMs: 50,
    })
    expect(reads).toBeNull()
    await sh(late)
    expect(readdirSync(dir)).toEqual([])
  })

  it('clears probe folders an earlier run left, and nothing else', async () => {
    mkdirSync(join(dir, 'folder-probe-old'))
    writeFileSync(join(dir, 'folder-probe-old', 'report'), 'x')
    writeFileSync(join(dir, 'folder-probe-stray'), 'x')
    writeFileSync(join(dir, 'k.owner.json'), '{}')
    await sweepKeptProbes(dir)
    expect(readdirSync(dir)).toEqual(['k.owner.json'])
    await expect(sweepKeptProbes(join(root, 'missing'))).resolves.toBeUndefined()
  })

  it('reads the folders from Ostia itself without reading any file', async () => {
    expect(await readFoldersInMain(home)).toEqual({
      Downloads: 'ok',
      Documents: 'other',
    })
  })

  it('tells Full Disk Access by whether a protected file opens', async () => {
    const file = join(root, 'db')
    writeFileSync(file, '')
    expect(await hasFullDiskAccess(file)).toBe(true)
    expect(await hasFullDiskAccess(join(root, 'missing'))).toBe(false)
  })
})
