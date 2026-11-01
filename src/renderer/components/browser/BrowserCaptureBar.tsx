import type { JSX } from 'react'
import { StatusLine } from '@/components/common/StatusLine'
import { useDict } from '@/lib/app/useDict'

interface BrowserCaptureBarProps {
  picking: { byAgent: boolean } | null
  cropping: boolean
}

export function BrowserCaptureBar({
  picking,
  cropping,
}: BrowserCaptureBarProps): JSX.Element | null {
  const d = useDict()
  if (!picking && !cropping) return null
  return (
    <StatusLine>
      {picking
        ? picking.byAgent
          ? d.browser.pickHintAgent
          : d.browser.pickHint
        : d.browser.regionHint}
    </StatusLine>
  )
}
