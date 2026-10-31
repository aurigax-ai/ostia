import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { tmuxConf } from '../main/tmux/tmuxConf'

const run = promisify(execFile)

const DEFAULT_TERMINAL = 'screen-256color'

export interface SessionSpec {
  name: string
  cwd: string
  env: Record<string, string>
  argv: string[]
}

export class TmuxHost {
  constructor(
    private readonly socket: string,
    private readonly conf: string,
  ) {}

  private async tmux(args: string[]): Promise<string> {
    mkdirSync(dirname(this.conf), { recursive: true, mode: 0o700 })
    writeFileSync(this.conf, `${tmuxConf(DEFAULT_TERMINAL)}set -g remain-on-exit off\n`, {
      mode: 0o600,
    })
    const { stdout } = await run('tmux', ['-S', this.socket, '-f', this.conf, ...args])
    return stdout
  }

  async sessions(): Promise<string[]> {
    try {
      return (await this.tmux(['list-sessions', '-F', '#{session_name}']))
        .split('\n')
        .filter(Boolean)
    } catch {
      return []
    }
  }

  async create(spec: SessionSpec): Promise<void> {
    const env = Object.entries(spec.env).flatMap(([key, value]) => ['-e', `${key}=${value}`])
    await this.tmux([
      'new-session',
      '-d',
      '-s',
      spec.name,
      '-c',
      spec.cwd,
      ...env,
      '--',
      ...spec.argv,
    ])
  }

  async kill(name: string): Promise<void> {
    await this.tmux(['kill-session', '-t', `=${name}`])
  }
}
