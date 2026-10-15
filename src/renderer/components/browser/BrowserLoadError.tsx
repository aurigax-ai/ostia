import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { useDict } from '@/lib/app/useDict'

interface BrowserLoadErrorProps {
  loadError: { url: string; reason: string }
  navigate: (raw: string) => void
}

export function BrowserLoadError({ loadError, navigate }: BrowserLoadErrorProps): JSX.Element {
  const d = useDict()
  return (
    <Empty className="browser-error" role="alert">
      <EmptyHeader className="max-w-full">
        <EmptyTitle className="text-fg text-ui-base">{d.browser.loadFailed}</EmptyTitle>
        <EmptyDescription className="font-mono text-ui-sm [overflow-wrap:anywhere]">
          {loadError.url}
        </EmptyDescription>
        <EmptyDescription className="text-ui-sm">{loadError.reason}</EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate(loadError.url)}>
        {d.browser.retry}
      </Button>
    </Empty>
  )
}
