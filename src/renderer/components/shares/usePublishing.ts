import type { PortableAction, PortableResult } from '@shared/artifacts/portable'
import type { PublishOptions, ShareView } from '@shared/artifacts/shares'
import { useState } from 'react'
import { useDict } from '@/lib/app/useDict'
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
  problem: string | null
}

export function usePublishing(filePath: string, run: RunPortable): Publishing {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const share = useSharesStore((s) => s.shares.find((x) => x.source === filePath) ?? null)
  return {
    name: filePath.slice(filePath.lastIndexOf('/') + 1),
    open,
    show: () => {
      setProblem(null)
      setOpen(true)
    },
    hide: () => setOpen(false),
    publish: (options) => run('publish', options),
    share,
    problem,
    unshare: async () => {
      if (!share) return
      const result = await useSharesStore.getState().remove(share.id)
      setProblem(result.ok ? null : shareFailureText(d, result.error))
    },
  }
}
