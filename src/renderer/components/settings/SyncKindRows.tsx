import type { SyncStatus } from '@shared/profileSync/profileSync'
import { parseSyncKinds, SYNC_KINDS, type SyncKind } from '@shared/profileSync/syncKinds'
import { type JSX, useState } from 'react'
import { ControlRow, ToggleRow } from '@/components/settingsKit/ControlRow'
import { SettingsSubgroup } from '@/components/settingsKit/SettingsGroup'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'

export function SyncKindRows({
  status,
  onStatus,
}: {
  status: SyncStatus
  onStatus: (status: SyncStatus) => void
}): JSX.Element {
  const d = useDict()
  const t = d.sync.kinds
  const text: Record<SyncKind, { label: string; desc: string }> = {
    settings: t.settings,
    snippets: t.snippets,
    completions: t.completions,
    views: t.views,
    extensions: t.extensions,
  }
  const stored = useSettingsStore((s) => s.sync?.kinds)
  const setSyncKinds = useSettingsStore((s) => s.setSyncKinds)
  const kinds = parseSyncKinds(stored)
  const offers = kinds.extensions ? status.offers : []
  const [installing, setInstalling] = useState<string | null>(null)

  const install = async (id: string): Promise<void> => {
    setInstalling(id)
    try {
      onStatus(await window.ostia.sync.install(id))
    } finally {
      setInstalling(null)
    }
  }

  return (
    <>
      {SYNC_KINDS.map((kind) => (
        <ToggleRow
          key={kind}
          label={text[kind].label}
          desc={text[kind].desc}
          checked={kinds[kind]}
          onChange={(on) => void setSyncKinds({ ...kinds, [kind]: on })}
        />
      ))}
      {offers.length > 0 ? <SettingsSubgroup title={t.offersTitle} desc={t.offersDesc} /> : null}
      {offers.map((offer) => (
        <ControlRow key={offer.id} label={offer.id} desc={offer.marketplace}>
          <Button
            variant="outline"
            size="sm"
            disabled={installing === offer.id}
            onClick={() => void install(offer.id)}
          >
            {d.sync.install}
          </Button>
        </ControlRow>
      ))}
    </>
  )
}
