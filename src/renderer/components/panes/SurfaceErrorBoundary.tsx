import { WarningIcon, XIcon } from '@phosphor-icons/react'
import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { commands } from '@/commands/registry'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import {
  type ErrorDetails,
  errorDetails,
  reportDetails,
  withComponentStack,
} from '@/lib/app/errorReporting'
import { useDict } from '@/lib/app/useDict'

function SurfaceError({ paneId, error }: { paneId: string; error: ErrorDetails }): JSX.Element {
  const d = useDict()
  return (
    <EmptyState
      variant="surface"
      size="sm"
      className="surface-error h-full w-full bg-surface-1"
      role="alert"
      icon={<WarningIcon aria-hidden />}
      title={d.crash.paneTitle}
      desc={d.crash.paneBody}
      actions={
        <>
          <pre className="app-recovery-error">{error.message}</pre>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void commands.exec('pane.close', { paneId })}
          >
            <XIcon data-icon="inline-start" aria-hidden />
            {d.crash.closePane}
          </Button>
        </>
      }
    />
  )
}

interface Props {
  paneId: string
  children: ReactNode
}

export class SurfaceErrorBoundary extends Component<Props, { error: ErrorDetails | null }> {
  state: { error: ErrorDetails | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: ErrorDetails } {
    return { error: errorDetails(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportDetails(
      'surface',
      withComponentStack(errorDetails(error), info.componentStack),
      `pane ${this.props.paneId}`,
    )
  }

  render(): ReactNode {
    const { error } = this.state
    return error ? <SurfaceError paneId={this.props.paneId} error={error} /> : this.props.children
  }
}
