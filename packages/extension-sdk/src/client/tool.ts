import { spawn } from 'node:child_process'

export interface ToolRun {
  code: number | null
  stdout: string
  stderr: string
  missing: boolean
  timedOut: boolean
}

export interface ToolRunOptions {
  cwd?: string
  timeoutMs?: number
  maxOutput?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024

export function runTool(bin: string, args: string[], opts: ToolRunOptions = {}): Promise<ToolRun> {
  const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (run: ToolRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(run)
    }
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOutput) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxOutput) stderr += chunk.toString('utf8')
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout,
        stderr: stderr || err.message,
        missing: err.code === 'ENOENT',
        timedOut,
      })
    })
    child.on('close', (code) => finish({ code, stdout, stderr, missing: false, timedOut }))
  })
}

export function nextBackoff(failures: number, baseMs: number, maxMs: number): number {
  if (failures <= 0) return baseMs
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures, 16))
}
