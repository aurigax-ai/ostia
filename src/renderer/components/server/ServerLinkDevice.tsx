import { useState } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import { type ServerErrorCode, serverErrorText } from './serverText'
import { useElevated } from './useElevated'

export function ServerLinkDevice(): JSX.Element {
  const d = useDict()
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState<ServerErrorCode | null>(null)
  const elevated = useElevated()

  const make = async (): Promise<void> => {
    setError(null)
    const res = await elevated.run(() => window.ostia.server.createInvite())
    if (res.ok) setCode(res.code)
    else setError(res.error)
  }

  return (
    <>
      <ControlRow
        label={d.server.linkLabel}
        desc={d.server.linkDesc}
        error={error ? serverErrorText(d, error) : null}
        below={
          code ? (
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-fg-muted text-ui-sm">
              <span>{d.server.linkCode}</span>
              <MachineValue value={code} />
              <output>{d.server.linkWaiting}</output>
            </span>
          ) : null
        }
      >
        <Button variant="outline" size="sm" onClick={() => void make()}>
          {d.server.linkMake}
        </Button>
      </ControlRow>
      {elevated.prompt}
    </>
  )
}
