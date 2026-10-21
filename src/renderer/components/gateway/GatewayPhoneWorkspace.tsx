import type {
  GatewayPhoneWorkspaceSave,
  PhoneAgentName,
  GatewayPhoneWorkspace as PhoneWorkspace,
} from '@shared/gateway/gatewayApi'
import { useCallback, useEffect, useState } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { ControlRow, ToggleRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'

type Dict = ReturnType<typeof useDict>

function problemText(d: Dict, problem: string): string {
  switch (problem) {
    case 'missing':
      return d.settings.phoneProblemMissing
    case 'home':
      return d.settings.phoneProblemHome
    case 'above-home':
      return d.settings.phoneProblemAboveHome
    case 'ostia-data':
      return d.settings.phoneProblemData
    case 'scratch-or-artifacts':
      return d.settings.phoneProblemScratch
    default:
      return d.settings.phoneProblemOther
  }
}

function trustText(d: Dict, trust: PhoneWorkspace['trust']): string {
  if (trust === 'trusted') return d.settings.phoneTrustTrusted
  return trust === 'ask' ? d.settings.phoneTrustAsk : d.settings.phoneTrustUnknown
}

export function GatewayPhoneWorkspace(): JSX.Element {
  const d = useDict()
  const [phone, setPhone] = useState<PhoneWorkspace | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.ostia.gateway.phoneWorkspace().then((value) => {
      if (alive) setPhone(value)
    })
    return () => {
      alive = false
    }
  }, [])

  const save = useCallback(
    async (next: GatewayPhoneWorkspaceSave): Promise<void> => {
      const res = await window.ostia.gateway.setPhoneWorkspace(next)
      if (res.ok) {
        setPhone(res.value)
        setError(null)
      } else {
        setError(problemText(d, res.error))
      }
    },
    [d],
  )

  if (!phone) return <SettingsGroup title={d.settings.phoneGroup}>{null}</SettingsGroup>
  const current: GatewayPhoneWorkspaceSave = {
    folder: phone.isDefault ? null : phone.folder,
    openNew: phone.openNew,
    agent: phone.agent,
  }
  const choose = async (): Promise<void> => {
    const picked = await window.ostia.sync.pickFolder()
    if (picked !== null) await save({ ...current, folder: picked })
  }
  const shownError = error ?? (phone.problem ? problemText(d, phone.problem) : null)

  return (
    <SettingsGroup title={d.settings.phoneGroup} desc={d.settings.phoneGroupDesc}>
      <ControlRow
        label={d.settings.phoneWorkspace}
        desc={phone.absent ? d.settings.phoneWorkspaceAbsent : d.settings.phoneWorkspaceDesc}
        error={shownError}
      >
        <div className="flex min-w-0 items-center gap-2">
          <MachineValue value={phone.folder} label={d.settings.phoneWorkspace} />
          <Button variant="outline" size="sm" onClick={() => void choose()}>
            {d.settings.phoneWorkspaceChoose}
          </Button>
          {phone.isDefault ? null : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void save({ ...current, folder: null })}
            >
              {d.settings.phoneWorkspaceDefault}
            </Button>
          )}
        </div>
      </ControlRow>
      <ToggleRow
        label={d.settings.phoneOpenNew}
        desc={d.settings.phoneOpenNewDesc}
        checked={phone.openNew}
        onChange={(openNew) => void save({ ...current, openNew })}
      />
      <ControlRow label={d.settings.phoneAgent} desc={d.settings.phoneAgentDesc}>
        <SelectField<PhoneAgentName>
          value={phone.agent}
          label={d.settings.phoneAgent}
          options={[
            { value: 'claude', label: 'claude' },
            { value: 'codex', label: 'codex' },
          ]}
          onChange={(agent) => void save({ ...current, agent })}
        />
      </ControlRow>
      <ControlRow label={d.settings.phoneTrust} desc={d.settings.phoneTrustDesc}>
        <span className="text-fg-muted text-ui-sm">{trustText(d, phone.trust)}</span>
      </ControlRow>
    </SettingsGroup>
  )
}
