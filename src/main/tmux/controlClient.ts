import { type ChildProcessWithoutNullStreams, type StdioOptions, spawn } from 'node:child_process'
import { closeSync, openSync, readdirSync } from 'node:fs'
import { type ControlEvent, ControlModeParser } from './controlMode'

const STDERR_CAP = 500

export interface ControlEnd {
  reason: string
  code: number | null
  signal: string | null
  stderr: string
}

export interface ControlHandlers {
  onEvent: (event: ControlEvent) => void
  onEnd: (end: ControlEnd) => void
}

function inheritedFds(): number[] {
  try {
    return readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')
      .map(Number)
      .filter((fd) => Number.isInteger(fd) && fd > 2)
  } catch {
    return []
  }
}

export function withoutInheritedFds(first: ('pipe' | 'ignore')[], devNull: number): StdioOptions {
  const highest = Math.max(2, ...inheritedFds())
  return [...first, ...Array.from({ length: highest - 2 }, () => devNull)]
}

export class ControlClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly parser: ControlModeParser
  private reason = ''
  private stderr = ''
  private ended = false

  constructor(
    tmux: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    private readonly handlers: ControlHandlers,
  ) {
    const devNull = openSync('/dev/null', 'r+')
    this.child = spawn(tmux, args, {
      env,
      stdio: withoutInheritedFds(['pipe', 'pipe', 'pipe'], devNull),
    }) as ChildProcessWithoutNullStreams
    closeSync(devNull)
    this.parser = new ControlModeParser((event) => {
      if (event.type === 'exit') this.reason = event.reason
      handlers.onEvent(event)
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.parser.push(chunk))
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (this.stderr.length < STDERR_CAP) this.stderr += chunk.toString('utf8')
    })
    this.child.on('error', (err) => {
      this.stderr += err.message
      this.finish(null, null)
    })
    this.child.on('close', (code, signal) => this.finish(code, signal))
    this.child.stdin.on('error', () => undefined)
  }

  write(line: string): void {
    this.child.stdin.write(`${line}\n`)
  }

  forgetPane(paneId: string): void {
    this.parser.forgetPane(paneId)
  }

  detach(): void {
    this.child.stdin.end()
  }

  stop(): void {
    this.child.stdin.end()
    this.child.kill()
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return
    this.ended = true
    this.handlers.onEnd({
      reason: this.reason,
      code,
      signal,
      stderr: this.stderr.trim().slice(0, STDERR_CAP),
    })
  }
}
