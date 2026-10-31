import type { RemoteChoice } from '@shared/remote/remoteSetup'
import { Segmented } from '@/components/common/Segmented'
import { FieldLine } from '@/components/settingsKit/FieldLine'
import { SelectField } from '@/components/settingsKit/SelectField'
import { Input } from '@/components/ui/input'
import { useDict } from '@/lib/app/useDict'

export function RemoteForm({
  hosts,
  value,
  onChange,
}: {
  hosts: readonly string[]
  value: RemoteChoice
  onChange: (next: RemoteChoice) => void
}): JSX.Element {
  const d = useDict()
  return (
    <div>
      <FieldLine
        label={d.remote.host}
        desc={hosts.length === 0 ? d.remote.hostsEmpty : d.remote.hostDesc}
      >
        <SelectField
          label={d.remote.host}
          value={value.host}
          options={hosts.map((host) => ({ value: host, label: host }))}
          onChange={(host) => onChange({ ...value, host })}
          disabled={hosts.length === 0}
        />
      </FieldLine>
      <FieldLine label={d.remote.folder} desc={d.remote.folderDesc}>
        <Input
          aria-label={d.remote.folder}
          className="w-80 font-mono"
          value={value.folder}
          onChange={(e) => onChange({ ...value, folder: e.target.value })}
        />
      </FieldLine>
      <FieldLine label={d.remote.agent}>
        <Segmented
          label={d.remote.agent}
          value={value.agent}
          options={[
            { value: 'claude', label: d.remote.agentClaude },
            { value: 'codex', label: d.remote.agentCodex },
          ]}
          onChange={(agent) => onChange({ ...value, agent })}
        />
      </FieldLine>
    </div>
  )
}
