import { format } from 'node:util'

type StderrWrite = typeof process.stderr.write

let allowed: RegExp[] = []
let unexpected: string[] = []
let restore: (() => void) | null = null

export function allowConsoleError(pattern: RegExp): void {
  allowed.push(pattern)
}

export function takeUnexpectedConsoleErrors(): string[] {
  const taken = unexpected
  unexpected = []
  return taken
}

function record(text: string): void {
  if (!allowed.some((pattern) => pattern.test(text))) unexpected.push(text)
}

export function startConsoleGuard(): void {
  allowed = []
  unexpected = []
  const { error, warn } = console
  const write = process.stderr.write
  console.error = (...args: unknown[]): void => record(format(...args))
  console.warn = (...args: unknown[]): void => record(format(...args))
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    if (text !== '') record(text)
    return true
  }) as StderrWrite
  restore = () => {
    console.error = error
    console.warn = warn
    process.stderr.write = write
  }
}

export function stopConsoleGuard(): void {
  restore?.()
  restore = null
  allowed = []
  const errors = takeUnexpectedConsoleErrors()
  if (errors.length > 0) {
    throw new Error(
      `console.error, console.warn or stderr was written ${errors.length} time(s); fix the cause or allow it with allowConsoleError:\n\n${errors.join('\n\n')}`,
    )
  }
}
