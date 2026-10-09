import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { useDict } from '@/i18n/useDict'
import {
  type ErrorDetails,
  errorDetails,
  errorReport,
  reportDetails,
  withComponentStack,
} from '@/lib/app/errorReporting'
import { ArrowClockwiseIcon, CopyIcon, FolderOpenIcon, WarningIcon } from '@phosphor-icons/react'
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react'

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
    <Empty className="app-recovery" role="alert">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <WarningIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle className="font-semibold text-fg text-ui-lg">
          <h1>{d.crash.title}</h1>
        </EmptyTitle>
        <EmptyDescription className="text-ui-base">{d.crash.body}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
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
      </EmptyContent>
    </Empty>
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
    void window.ostia?.diagnostics
      ?.testHooks()
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
