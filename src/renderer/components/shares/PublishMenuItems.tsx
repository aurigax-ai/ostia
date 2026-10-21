import { useEffect } from 'react'
import { MenuItem } from '@/components/common/Menu'
import { useDict } from '@/lib/app/useDict'
import { useSharesStore } from '@/stores/files/sharesStore'
import { disabledHint } from './shareText'
import type { Publishing } from './usePublishing'

export function PublishMenuItems({ publishing }: { publishing: Publishing }): JSX.Element {
  const d = useDict()
  const availability = useSharesStore((s) => s.availability)
  useEffect(() => {
    void useSharesStore.getState().refresh()
  }, [])
  const hint = disabledHint(d, availability)
  return (
    <>
      <MenuItem disabled={hint !== null} hint={hint} onClick={publishing.show}>
        {d.shares.publishMenu}
      </MenuItem>
      {publishing.share ? (
        <MenuItem onClick={() => void publishing.unshare()}>{d.shares.deleteShared}</MenuItem>
      ) : null}
    </>
  )
}
