import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { useState } from 'react'
import { StatusLine } from '@/components/common/StatusLine'
import { fmt, useDict } from '@/lib/app/useDict'

export function NoNewPrivsStatus(): JSX.Element | null {
  const d = useDict()
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || !window.ostia.system.noNewPrivs) return null
  return (
    <div className="absolute inset-x-0 top-0 z-20">
      <StatusLine tone="warn" wrap data-no-new-privs-status="" onDismiss={() => setDismissed(true)}>
        {fmt(d.noNewPrivs.message, { product: PRODUCT_DISPLAY_NAME })}
      </StatusLine>
    </div>
  )
}
