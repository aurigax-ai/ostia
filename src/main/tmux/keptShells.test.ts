import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_PROTOCOL_VERSION } from '../sandbox/protocol'
import { KeptShells, parseKeptHost } from './keptShells'

const host = {
  kind: 'sandbox-host',
  workspaceId: 'w1',
  channel: '/tmp/host.sock',
  tmpDir: '/tmp/host',
  protocol: HOST_PROTOCOL_VERSION,
  exposed: [],
}

describe('parseKeptHost', () => {
  it('reads a sandbox host record', () => {
    expect(parseKeptHost(host)).toEqual(host)
  })

  it('refuses a record that states no protocol version', () => {
    const { protocol: _protocol, ...withoutProtocol } = host
    expect(parseKeptHost(withoutProtocol)).toBeNull()
    expect(parseKeptHost({ ...host, protocol: '1' })).toBeNull()
  })
})

function keptShells(dir: string, program = vi.fn(() => null)) {
  return {
    program,
    kept: new KeptShells({ dir, name: 'k', program, log: () => undefined }),
  }
}

describe('KeptShells without tmux running', () => {
  let dir: string

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'kept-shells-')), 'sock')
  })

  afterEach(() => {
    rmSync(join(dir, '..'), { recursive: true, force: true })
  })

  it('KSH-C1 KSH-C81 with the setting off starts no tmux and creates no socket folder', async () => {
    const { kept, program } = keptShells(dir)
    await kept.start(false, null)
    expect(program).not.toHaveBeenCalled()
    expect(existsSync(dir)).toBe(false)
  })

  it('KSH-C72 KSH-C74 holds a pane token only in its own 0600 file, rewritten with the new token', () => {
    const { kept } = keptShells(dir)
    const file = kept.writeToken('p1', 'token-one')
    expect(readFileSync(file, 'utf8')).toBe('token-one')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
    expect(kept.writeToken('p1', 'token-two')).toBe(file)
    expect(readFileSync(file, 'utf8')).toBe('token-two')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(kept.tokenFile('p2')).not.toBe(file)
  })
})
