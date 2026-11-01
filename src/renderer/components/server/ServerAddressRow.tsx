import type { ServerStatus } from '@shared/server/serverApi'
import type { JSX } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { useDict } from '@/lib/app/useDict'

export function ServerAddressRow({ status }: { status: ServerStatus }): JSX.Element {
  const d = useDict()
  return (
    <ControlRow label={d.server.addressLabel}>
      <MachineValue value={status.url ?? ''} />
    </ControlRow>
  )
}
