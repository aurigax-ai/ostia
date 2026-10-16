import { spawn } from 'node:child_process'
import { closeSync, copyFileSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { inheritableFds, withoutInheritedFiles } from './inheritableFiles'

const LEAKED_FD = 40

function childReport(
  held: string,
  probe = 'ls -l /proc/self/fd',
): Promise<{ fds: number[]; seen: string }> {
  const module = join(mkdtempSync(join(tmpdir(), 'ostia-inheritable-module-')), 'module.mts')
  copyFileSync(join(__dirname, 'inheritableFiles.ts'), module)
  const MODULE = pathToFileURL(module).href
  const script = `
    const { spawnSync } = await import('node:child_process')
    const { inheritableFds, withoutInheritedFiles } = await import(${JSON.stringify(MODULE)})
    const fds = inheritableFds()
    const { stdio, release } = withoutInheritedFiles(['ignore', 'pipe', 'ignore'], fds)
    const seen = spawnSync('/bin/sh', ['-c', ${JSON.stringify(probe)}], { stdio }).stdout.toString()
    release()
    process.stdout.write(JSON.stringify({ fds, seen }))
  `
  const fd = openSync(held, 'r')
  const stdio: ('ignore' | 'pipe' | 'inherit' | number)[] = ['ignore', 'pipe', 'inherit']
  while (stdio.length < LEAKED_FD) stdio.push('ignore')
  stdio.push(fd)
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio })
  closeSync(fd)
  let out = ''
  child.stdout?.on('data', (chunk) => {
    out += chunk
  })
  return new Promise((resolve, reject) =>
    child.on('exit', (code) =>
      code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}`)),
    ),
  )
}

describe('files a spawned program would inherit', () => {
  it.runIf(process.platform === 'linux')(
    'GRF-C226 a descriptor main left inheritable is found, and the child gets /dev/null in its place',
    async () => {
      const held = join(mkdtempSync(join(tmpdir(), 'ostia-inheritable-')), 'held')
      writeFileSync(held, '')
      const { fds, seen } = await childReport(held)
      expect(fds).toContain(LEAKED_FD)
      expect(seen).not.toContain(held)
      expect(seen).toMatch(new RegExp(`\\b${LEAKED_FD} -> /dev/null`))
    },
  )

  it.runIf(process.platform === 'darwin')(
    'GRF-C226 on macOS a descriptor main left inheritable never reaches a spawned program (libuv spawns with POSIX_SPAWN_CLOEXEC_DEFAULT)',
    async () => {
      const held = join(mkdtempSync(join(tmpdir(), 'ostia-inheritable-')), 'held')
      writeFileSync(held, '')
      const { seen } = await childReport(
        held,
        `if [ -e /dev/fd/${LEAKED_FD} ]; then echo held; else echo free; fi`,
      )
      expect(seen.trim()).toBe('free')
    },
  )

  it('finds nothing and changes nothing off Linux', () => {
    expect(inheritableFds('darwin')).toEqual([])
    expect(withoutInheritedFiles(['ignore', 'ignore', 'ignore'], []).stdio).toEqual([
      'ignore',
      'ignore',
      'ignore',
    ])
  })
})
