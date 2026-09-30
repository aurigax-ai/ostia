import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SOCKET_WAIT_MS = 5000

export interface SshAgent {
  socket: string
  stop: () => void
}

async function waitFor(path: string): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < SOCKET_WAIT_MS) {
    if (existsSync(path)) return true
    await sleep(25)
  }
  return false
}

export async function startSshAgent(dir: string, keys: readonly string[]): Promise<SshAgent> {
  const socket = join(dir, 'agent.sock')
  const child = spawn('ssh-agent', ['-D', '-a', socket], { stdio: 'ignore' })
  const stop = (): void => {
    if (child.exitCode === null) child.kill()
  }
  if (!(await waitFor(socket))) {
    stop()
    throw new Error('ssh-agent did not start')
  }
  try {
    for (const key of keys) {
      await run('ssh-add', ['-q', key], { env: { ...process.env, SSH_AUTH_SOCK: socket } })
    }
  } catch (err) {
    stop()
    throw err
  }
  return { socket, stop }
}
