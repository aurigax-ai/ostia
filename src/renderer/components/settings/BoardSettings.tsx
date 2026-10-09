import { useDict } from '@/i18n/useDict'
import { useSettingsStore } from '@/stores/settingsStore'
import { GIT_POLL_SECONDS } from '@shared/boards/git'
import { PORTS_INTERVAL_SECONDS, type PortHost } from '@shared/boards/ports'
import {
  ControlRow,
  NumberRow,
  SectionHead,
  SelectField,
  SettingsGroup,
  ToggleRow,
} from './SettingsPanel'

const PORT_HOSTS: readonly PortHost[] = ['localhost', '127.0.0.1']

export function GitSection(): JSX.Element {
  const d = useDict()
  const git = useSettingsStore((s) => s.git)
  const set = useSettingsStore((s) => s.setGit)
  return (
    <div>
      <SectionHead title={d.git.title} desc={d.git.settingsDesc} />
      <SettingsGroup title={d.git.groupStatus}>
        <ToggleRow
          label={d.git.enabled}
          desc={d.git.enabledDesc}
          checked={git.enabled}
          onChange={(enabled) => set({ enabled })}
        />
        <NumberRow
          label={d.git.pollSeconds}
          desc={d.git.pollSecondsDesc}
          value={git.pollSeconds}
          min={GIT_POLL_SECONDS.min}
          max={GIT_POLL_SECONDS.max}
          onCommit={(pollSeconds) => set({ pollSeconds })}
        />
        <ToggleRow
          label={d.git.showDiffStats}
          desc={d.git.showDiffStatsDesc}
          checked={git.showDiffStats}
          onChange={(showDiffStats) => set({ showDiffStats })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.git.groupPanel}>
        <ControlRow label={d.git.graphScope} desc={d.git.graphScopeDesc}>
          <SelectField
            value={git.graphScope}
            onChange={(graphScope) => set({ graphScope })}
            label={d.git.graphScope}
            options={[
              { value: 'current', label: d.git.scopeCurrent },
              { value: 'all', label: d.git.scopeAll },
            ]}
          />
        </ControlRow>
        <ControlRow label={d.git.changesView} desc={d.git.changesViewDesc}>
          <SelectField
            value={git.changesView}
            onChange={(changesView) => set({ changesView })}
            label={d.git.changesView}
            options={[
              { value: 'list', label: d.git.viewList },
              { value: 'tree', label: d.git.viewTree },
            ]}
          />
        </ControlRow>
      </SettingsGroup>
    </div>
  )
}

export function PortsSection(): JSX.Element {
  const d = useDict()
  const ports = useSettingsStore((s) => s.ports)
  const set = useSettingsStore((s) => s.setPorts)
  return (
    <div>
      <SectionHead title={d.ports.title} desc={d.ports.settingsDesc} />
      <SettingsGroup title={d.ports.groupScan}>
        <ToggleRow
          label={d.ports.enabled}
          desc={d.ports.enabledDesc}
          checked={ports.enabled}
          onChange={(enabled) => set({ enabled })}
        />
        <NumberRow
          label={d.ports.intervalSeconds}
          desc={d.ports.intervalSecondsDesc}
          value={ports.intervalSeconds}
          min={PORTS_INTERVAL_SECONDS.min}
          max={PORTS_INTERVAL_SECONDS.max}
          onCommit={(intervalSeconds) => set({ intervalSeconds })}
        />
        <ControlRow label={d.ports.portHost} desc={d.ports.portHostDesc}>
          <SelectField
            value={ports.portHost}
            onChange={(portHost) => set({ portHost })}
            label={d.ports.portHost}
            options={PORT_HOSTS.map((host) => ({ value: host, label: host }))}
          />
        </ControlRow>
      </SettingsGroup>
    </div>
  )
}
