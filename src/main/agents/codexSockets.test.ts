import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexSocketPath, forgetCodexSocket, registerCodexSocket } from './codexSockets'

describe('codex sockets', () => {
  it('lives in its own 0700 directory, apart from the shell state directory', () => {
    const path = codexSocketPath()
    expect(dirname(path)).not.toContain('shell-state')
    expect(statSync(dirname(path)).mode & 0o077).toBe(0)
  })

  it('kills the server and removes its files when the pane closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-sock-'))
    const sock = join(dir, 'p.sock')
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    const exited = new Promise<string | null>((resolve) =>
      child.on('exit', (_, sig) => resolve(sig)),
    )
    writeFileSync(sock, '')
    writeFileSync(`${sock}.pid`, String(child.pid))
    registerCodexSocket('pane-x', sock)
    forgetCodexSocket('pane-x')
    expect(await exited).toBe('SIGTERM')
    expect(existsSync(sock)).toBe(false)
    expect(existsSync(`${sock}.pid`)).toBe(false)
  })
})
