import type { AppLog } from './appLog'

const ERRNO = /^E(?!RR_)[A-Z0-9]+$/

let sink: AppLog | null = null

export function setErrorSink(log: AppLog | null): void {
  sink = log
}

export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && ERRNO.test(String((err as NodeJS.ErrnoException).code))
}

export function expectErrno(err: unknown): void {
  if (!isErrno(err)) throw err
}

export function reportError(scope: string, err: unknown): void {
  const fields = {
    scope,
    name: err instanceof Error ? err.name : typeof err,
    code: isErrno(err) ? err.code : undefined,
  }
  if (sink) sink.warn('unexpected-error', fields)
  else console.error('[unexpected-error]', fields)
}
