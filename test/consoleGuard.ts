import { format } from 'node:util'

let allowed: RegExp[] = []
let unexpected: string[] = []
let original: typeof console.error | null = null

export function allowConsoleError(pattern: RegExp): void {
  allowed.push(pattern)
}

export function takeUnexpectedConsoleErrors(): string[] {
  const taken = unexpected
  unexpected = []
  return taken
}

export function startConsoleGuard(): void {
  allowed = []
  unexpected = []
  original = console.error
  console.error = (...args: unknown[]): void => {
    const text = format(...args)
    if (!allowed.some((pattern) => pattern.test(text))) unexpected.push(text)
  }
}

export function stopConsoleGuard(): void {
  if (original) console.error = original
  original = null
  allowed = []
  const errors = takeUnexpectedConsoleErrors()
  if (errors.length > 0) {
    throw new Error(
      `console.error was called ${errors.length} time(s); fix the cause or allow it with allowConsoleError:\n\n${errors.join('\n\n')}`,
    )
  }
}
