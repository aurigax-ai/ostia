import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearControlInfo,
  controlInfoPath,
  readControlSocket,
  writeControlInfo,
} from './controlDiscovery'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'control-info-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('control socket discovery', () => {
  it('lives in the app data folder', () => {
    expect(controlInfoPath({ XDG_DATA_HOME: '/data' })).toBe('/data/ostia/control.json')
  })

  it('points scripts at the socket of the running app, privately', () => {
    const dir = tempDir()
    const info = join(dir, 'control.json')
    const socket = join(dir, 'ostia-1.sock')
    writeFileSync(socket, '')
    writeControlInfo(info, socket, 1)

    expect(readControlSocket(info)).toBe(socket)
    expect(statSync(info).mode & 0o777).toBe(0o600)
  })

  it('finds nothing when the socket is gone or the file is missing', () => {
    const dir = tempDir()
    const info = join(dir, 'control.json')
    expect(readControlSocket(info)).toBeUndefined()
    writeControlInfo(info, join(dir, 'gone.sock'), 1)
    expect(readControlSocket(info)).toBeUndefined()
  })

  it('clears the file only for its own socket', () => {
    const dir = tempDir()
    const info = join(dir, 'control.json')
    const socket = join(dir, 'a.sock')
    writeFileSync(socket, '')
    writeControlInfo(info, socket, 1)
    clearControlInfo(info, join(dir, 'b.sock'))
    expect(readControlSocket(info)).toBe(socket)
    clearControlInfo(info, socket)
    expect(readControlSocket(info)).toBeUndefined()
  })
})
