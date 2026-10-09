import { commands } from '@/commands/registry'
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
  reportDetails,
  withComponentStack,
} from '@/lib/app/errorReporting'
import { WarningIcon, XIcon } from '@phosphor-icons/react'
import { Component, type ErrorInfo, type ReactNode } from 'react'

function SurfaceError({ paneId, error }: { paneId: string; error: ErrorDetails }): JSX.Element {
  const d = useDict()
  return (
    <Empty className="surface-error h-full w-full bg-surface-1" role="alert">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <WarningIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle className="font-semibold text-fg text-ui-base">{d.crash.paneTitle}</EmptyTitle>
        <EmptyDescription className="text-ui-sm">{d.crash.paneBody}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <pre className="app-recovery-error">{error.message}</pre>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void commands.exec('pane.close', { paneId })}
        >
          <XIcon data-icon="inline-start" aria-hidden />
          {d.crash.closePane}
        </Button>
      </EmptyContent>
    </Empty>
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
