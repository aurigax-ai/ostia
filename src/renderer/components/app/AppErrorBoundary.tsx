import { ArrowClockwiseIcon, CopyIcon, FolderOpenIcon, WarningIcon } from '@phosphor-icons/react'
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import {
  type ErrorDetails,
  errorDetails,
  errorReport,
  reportDetails,
  withComponentStack,
} from '@/lib/app/errorReporting'
import { useDict } from '@/lib/app/useDict'

export function RecoveryScreen({ error }: { error: ErrorDetails }): JSX.Element {
  const d = useDict()
  const [version, setVersion] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    window.ostia
      ?.info?.()
      .then((info) => {
        if (alive) setVersion(info.version)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(errorReport(error, version))
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  return (
    <EmptyState
      variant="surface"
      className="app-recovery"
      role="alert"
      icon={<WarningIcon aria-hidden />}
      title={d.crash.title}
      titleAs="h1"
      desc={d.crash.body}
      actions={
        <>
          <pre className="app-recovery-error">{error.message}</pre>
          <div className="app-recovery-actions">
            <Button onClick={() => window.ostia.diagnostics.reloadWindow()}>
              <ArrowClockwiseIcon data-icon="inline-start" aria-hidden />
              {d.crash.reload}
            </Button>
            <Button variant="outline" onClick={copy}>
              <CopyIcon data-icon="inline-start" aria-hidden />
              {copied ? d.crash.copied : d.crash.copy}
            </Button>
            <Button variant="outline" onClick={() => void window.ostia.diagnostics.openLogFolder()}>
              <FolderOpenIcon data-icon="inline-start" aria-hidden />
              {d.crash.openLogs}
            </Button>
          </div>
        </>
      }
    />
  )
}

interface BoundaryState {
  error: ErrorDetails | null
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: errorDetails(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportDetails('render', withComponentStack(errorDetails(error), info.componentStack))
  }

  render(): ReactNode {
    return this.state.error ? <RecoveryScreen error={this.state.error} /> : this.props.children
  }
}

export function CrashTestHook(): null {
  const [crash, setCrash] = useState(false)
  useEffect(() => {
    let off: (() => void) | null = null
    let alive = true
    void window.ostia.diagnostics
      .testHooks()
      .then((enabled) => {
        if (enabled && alive) off = window.ostia.diagnostics.onTestCrash(() => setCrash(true))
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off?.()
    }
  }, [])
  if (crash) throw new Error('test crash requested by the E2E hook')
  return null
}
