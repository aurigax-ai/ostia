import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const FAKE_SSH_DIR = resolve(__dirname)
export const FAKE_SSH = join(FAKE_SSH_DIR, 'bin', 'ssh')
export const HELPER_SOURCE = resolve(__dirname, '../../../src/extensions/ssh/assets/helper.sh')

export function helperSource(): Buffer {
  return readFileSync(HELPER_SOURCE)
}

export interface RemoteHost {
  home: string
  log: string
  env: NodeJS.ProcessEnv
  spawn: (argv: string[]) => ChildProcessWithoutNullStreams
  runs: () => string[]
  cleanup: () => void
}

export function toolPath(tools: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-ssh-tools-'))
  for (const tool of tools) {
    for (const from of ['/usr/bin', '/bin']) {
      try {
        readFileSync(join(from, tool))
        symlinkSync(join(from, tool), join(dir, tool))
        break
      } catch {}
    }
  }
  return dir
}

export function remoteHost(opts: { path?: string } = {}): RemoteHost {
  const root = mkdtempSync(join(tmpdir(), 'ostia-ssh-remote-'))
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  mkdirSync(home)
  mkdirSync(tmp)
  const log = join(root, 'ssh.log')
  const env: NodeJS.ProcessEnv = {
    PATH: opts.path ?? process.env.PATH,
    TERM: 'dumb',
    FAKE_SSH_DIR,
    FAKE_SSH_LOG: log,
    FAKE_SSH_REMOTE_SHELL: '/bin/sh',
    FAKE_SSH_REMOTE_HOME: home,
    FAKE_SSH_REMOTE_TMP: tmp,
  }
  return {
    home,
    log,
    env,
    spawn: (argv) => spawn(FAKE_SSH, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env }),
    runs: () => {
      try {
        return readFileSync(log, 'utf8').split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
