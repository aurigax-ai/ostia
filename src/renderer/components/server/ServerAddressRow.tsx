import type { ServerStatus } from '@shared/server/serverApi'
import { useState } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { CommitInput } from '@/components/settingsKit/CommitInput'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { useDict } from '@/lib/app/useDict'
import { type ServerErrorCode, serverErrorText } from './serverText'

export function ServerAddressRow({ status }: { status: ServerStatus }): JSX.Element {
  const d = useDict()
  const [error, setError] = useState<ServerErrorCode | null>(null)

  const save = async (text: string): Promise<void> => {
    const result = await window.ostia.server.setUrl(text)
    setError(result.ok ? null : result.error)
  }

  if (status.signedIn) {
    return (
      <ControlRow label={d.server.addressLabel}>
        <MachineValue value={status.url ?? ''} />
      </ControlRow>
    )
  }

  return (
    <ControlRow
      label={d.server.addressLabel}
      error={error ? serverErrorText(d, error) : null}
      errorId="server-address-error"
    >
      <CommitInput
        value={status.url ?? ''}
        spellCheck={false}
        placeholder={d.server.addressPlaceholder}
        aria-label={d.server.addressLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'server-address-error' : undefined}
        onCommit={(text) => {
          void save(text)
          return true
        }}
        onCancel={() => setError(null)}
        className="h-7 w-64 font-mono"
      />
    </ControlRow>
  )
}
