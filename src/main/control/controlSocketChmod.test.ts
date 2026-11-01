import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setErrorSink } from '../diagnostics/errorReport'

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  chmodSync: () => {
    throw Object.assign(new Error('read-only'), { code: 'EPERM' })
  },
}))

import { type ControlServerDeps, registerControlServer, stopControlServer } from './controlServer'

const deps = {
  isSandboxed: () => false,
  execCommand: async () => ({ ok: true, result: null }),
  listCommandsFor: () => [],
  getTerminalState: () => null,
} as unknown as ControlServerDeps

let dir = ''

afterEach(() => {
  stopControlServer()
  setErrorSink(null)
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('the control socket', () => {
  it('refuses to serve on a socket it could not restrict to its owner, and logs it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-chmod-'))
    const path = join(dir, 'c.sock')
    const warn = vi.fn()
    setErrorSink({ file: '', info: vi.fn(), warn, error: vi.fn() })
    registerControlServer(deps, path)
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(warn).toHaveBeenCalledWith('unexpected-error', {
      scope: 'controlSocketChmod',
      name: 'Error',
      code: 'EPERM',
    })
    expect(existsSync(path)).toBe(false)
    await new Promise<void>((resolve) => {
      const socket = createConnection(path)
      socket.on('error', (err: NodeJS.ErrnoException) => {
        expect(err.code).toBe('ENOENT')
        resolve()
      })
      socket.on('connect', () => {
        socket.destroy()
        throw new Error('the socket still serves')
      })
    })
  })
})
