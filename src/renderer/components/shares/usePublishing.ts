import type { PortableAction, PortableResult } from '@shared/artifacts/portable'
import type { PublishOptions, ShareView } from '@shared/artifacts/shares'
import { useState } from 'react'
import { useDict } from '@/lib/app/useDict'
import type { CaptureChipTone } from '@/lib/capture/captureSession'
import { useSharesStore } from '@/stores/files/sharesStore'
import { shareFailureText } from './shareText'

export type RunPortable = (
  action: PortableAction,
  publish?: PublishOptions,
) => Promise<PortableResult | null>

export interface Publishing {
  name: string
  open: boolean
  show: () => void
  hide: () => void
  publish: (options: PublishOptions) => Promise<PortableResult | null>
  share: ShareView | null
  unshare: () => Promise<void>
  linkCopied: () => void
}

export function usePublishing(
  filePath: string,
  run: RunPortable,
  say: (text: string, tone: CaptureChipTone) => void,
): Publishing {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const share = useSharesStore((s) => s.shares.find((x) => x.source === filePath) ?? null)
  return {
    name: filePath.slice(filePath.lastIndexOf('/') + 1),
    open,
    show: () => setOpen(true),
    hide: () => setOpen(false),
    publish: (options) => run('publish', options),
    share,
    linkCopied: () => say(d.shares.publishedLinkCopied, 'ok'),
    unshare: async () => {
      if (!share) return
      const result = await useSharesStore.getState().remove(share.id)
      if (!result.ok) say(shareFailureText(d, result.error), 'warn')
    },
  }
}
