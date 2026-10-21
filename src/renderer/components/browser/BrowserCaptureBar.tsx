import { RegionActionBar } from '@/components/agents/RegionActionBar'
import { StatusLine } from '@/components/common/StatusLine'
import { useDict } from '@/lib/app/useDict'
import type { useBrowserCapture } from './useBrowserCapture'

interface BrowserCaptureBarProps {
  picking: { byAgent: boolean } | null
  cropping: boolean
  status: string | null
}

export function BrowserCaptureBar({
  picking,
  cropping,
  status,
}: BrowserCaptureBarProps): JSX.Element | null {
  const d = useDict()
  if (!picking && !cropping && !status) return null
  return (
    <StatusLine>
      {picking
        ? picking.byAgent
          ? d.browser.pickHintAgent
          : d.browser.pickHint
        : cropping
          ? d.browser.regionHint
          : status}
    </StatusLine>
  )
}

type BrowserCapture = ReturnType<typeof useBrowserCapture>

export function BrowserCaptureActions({
  workspaceId,
  bar,
  closeBar,
  copyBar,
  sendBar,
}: Pick<BrowserCapture, 'bar' | 'closeBar' | 'copyBar' | 'sendBar'> & {
  workspaceId: string
}): JSX.Element | null {
  if (!bar) return null
  return (
    <RegionActionBar
      key={bar.key}
      workspaceId={workspaceId}
      anchor={bar.anchor}
      onCopy={copyBar}
      onSend={sendBar}
      onClose={closeBar}
    />
  )
}
