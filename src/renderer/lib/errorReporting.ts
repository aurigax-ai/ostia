import type { RendererErrorKind } from '@shared/types'

export interface ErrorDetails {
  message: string
  stack?: string
}

export function errorDetails(err: unknown): ErrorDetails {
  if (err instanceof Error) {
    return { message: err.message || err.name, ...(err.stack ? { stack: err.stack } : {}) }
  }
  if (typeof err === 'string') return { message: err }
  try {
    return { message: JSON.stringify(err) ?? String(err) }
  } catch {
    return { message: String(err) }
  }
}

export function reportDetails(
  kind: RendererErrorKind,
  details: ErrorDetails,
  source?: string,
): void {
  try {
    window.ostia?.diagnostics?.report({ kind, ...details, ...(source ? { source } : {}) })
  } catch {}
}

export function reportError(kind: RendererErrorKind, err: unknown, source?: string): void {
  reportDetails(kind, errorDetails(err), source)
}

export function withComponentStack(
  details: ErrorDetails,
  componentStack?: string | null,
): ErrorDetails {
  const stack = [details.stack, componentStack].filter(Boolean).join('\n')
  return stack ? { message: details.message, stack } : { message: details.message }
}

export function errorReport(details: ErrorDetails, version: string | null): string {
  return [version ? `version: ${version}` : null, `error: ${details.message}`, details.stack ?? '']
    .filter((line): line is string => line !== null)
    .join('\n')
    .trim()
}

export function startErrorReporting(target: Window = window): () => void {
  const onError = (event: ErrorEvent): void => {
    const source = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined
    reportError('error', event.error ?? event.message, source)
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    reportError('rejection', event.reason)
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
