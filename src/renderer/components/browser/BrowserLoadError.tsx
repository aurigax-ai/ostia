import type { JSX } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'

interface BrowserLoadErrorProps {
  loadError: { url: string; reason: string }
  navigate: (raw: string) => void
}

export function BrowserLoadError({ loadError, navigate }: BrowserLoadErrorProps): JSX.Element {
  const d = useDict()
  return (
    <EmptyState
      variant="surface"
      size="sm"
      className="browser-error"
      role="alert"
      headerClassName="max-w-full"
      title={d.browser.loadFailed}
      titleClassName="font-medium"
      desc={[
        <span key="url" className="font-mono [overflow-wrap:anywhere]">
          {loadError.url}
        </span>,
        loadError.reason,
      ]}
      descClassName="text-fg-muted"
    >
      <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate(loadError.url)}>
        {d.browser.retry}
      </Button>
    </EmptyState>
  )
}
