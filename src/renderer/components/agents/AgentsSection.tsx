import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { ApprovalMode } from '@shared/permissions/approvals'
import { parseReachMode, REACH_MODES, type ReachMode } from '@shared/permissions/reach'
import { Notice } from '@/components/common/Notice'
import { ControlRow, NumberRow, ToggleRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import {
  HIBERNATION_IDLE_MAX,
  HIBERNATION_IDLE_MIN,
  HIBERNATION_LIVE_MAX,
} from '@/stores/app/settingsModel'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { capLabel } from './ApprovalCard'

const NO_GRANTS: readonly Capability[] = []

function AlwaysAllowedGroup(): JSX.Element {
  const d = useDict()
  const caps = useSettingsStore((s) => s.capabilities?.grants ?? NO_GRANTS)
  return (
    <SettingsGroup title={d.approvals.always} desc={d.approvals.alwaysDesc}>
      {caps.length === 0 ? (
        <p className="py-1.5 text-fg-muted text-ui-sm">{d.approvals.alwaysNone}</p>
      ) : (
        caps.map((cap) => (
          <ControlRow key={cap} label={capLabel(d.approvals.caps, cap)}>
            <Button
              variant="outline"
              size="xs"
              onClick={() => void window.ostia.approvals.removeAlways(cap)}
            >
              {d.approvals.alwaysRemove}
            </Button>
          </ControlRow>
        ))
      )}
    </SettingsGroup>
  )
}

function ReachGroup(): JSX.Element {
  const d = useDict()
  const reach = useSettingsStore((s) => parseReachMode(s.capabilities?.reach))
  const label: Record<ReachMode, string> = {
    workspace: d.approvals.reachWorkspace,
    project: d.approvals.reachProject,
    group: d.approvals.reachGroup,
  }
  const explain: Record<ReachMode, string> = {
    workspace: d.approvals.reachWorkspaceDesc,
    project: d.approvals.reachProjectDesc,
    group: d.approvals.reachGroupDesc,
  }
  return (
    <SettingsGroup title={d.approvals.reach} desc={d.approvals.reachDesc}>
      <ControlRow label={d.approvals.reach} desc={explain[reach]}>
        <SelectField
          value={reach}
          onChange={(mode) => void window.ostia.approvals.setReach(mode)}
          label={d.approvals.reach}
          options={REACH_MODES.map((mode) => ({ value: mode, label: label[mode] }))}
        />
      </ControlRow>
    </SettingsGroup>
  )
}

export function AgentsSection(): JSX.Element {
  const d = useDict()
  const hibernation = useSettingsStore((s) => s.agents.hibernation)
  const set = useSettingsStore((s) => s.setHibernation)
  const autoResume = useSettingsStore((s) => s.agents.autoResume)
  const setAutoResume = useSettingsStore((s) => s.setAutoResume)
  const trustWorkspaceFolders = useSettingsStore((s) => s.agents.trustWorkspaceFolders)
  const setTrustWorkspaceFolders = useSettingsStore((s) => s.setTrustWorkspaceFolders)
  const autoSendReferences = useSettingsStore((s) => s.agents.autoSendReferences)
  const setAutoSendReferences = useSettingsStore((s) => s.setAutoSendReferences)
  const hooks = useSettingsStore((s) => s.agents.hooks)
  const setAgentHooks = useSettingsStore((s) => s.setAgentHooks)
  const approvalMode = useSettingsStore((s) => s.approvals.mode)
  const setApprovalMode = useSettingsStore((s) => s.setApprovalMode)
  return (
    <SettingsPage title={d.settings.agents}>
      <SettingsGroup title={d.approvals.inbox}>
        <ControlRow label={d.approvals.mode} desc={d.approvals.modeDesc}>
          <SelectField
            value={approvalMode}
            onChange={(mode) => setApprovalMode(mode as ApprovalMode)}
            label={d.approvals.mode}
            options={[
              { value: 'ask', label: d.approvals.modeAsk },
              { value: 'allow', label: d.approvals.modeAllow },
            ]}
          />
        </ControlRow>
      </SettingsGroup>
      <ReachGroup />
      <AlwaysAllowedGroup />
      <SettingsGroup title={d.settings.groupResume}>
        <ToggleRow
          label={d.settings.autoResume}
          desc={d.settings.autoResumeDesc}
          checked={autoResume}
          onChange={setAutoResume}
        />
        <ToggleRow
          label={d.settings.trustWorkspaceFolders}
          desc={d.settings.trustWorkspaceFoldersDesc}
          checked={trustWorkspaceFolders}
          onChange={setTrustWorkspaceFolders}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupReferences}>
        <ToggleRow
          label={d.settings.autoSendReferences}
          desc={d.settings.autoSendReferencesDesc}
          checked={autoSendReferences}
          onChange={setAutoSendReferences}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupAgentHooks}>
        <ToggleRow
          label={d.settings.claudeHooks}
          desc={d.settings.claudeHooksDesc}
          checked={hooks.claude}
          onChange={(v) => setAgentHooks({ claude: v })}
        />
        <ToggleRow
          label={d.settings.codexHooks}
          desc={d.settings.codexHooksDesc}
          checked={hooks.codex}
          onChange={(v) => setAgentHooks({ codex: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupPerformance}>
        <ToggleRow
          label={d.settings.hibernate}
          desc={d.settings.hibernateDesc}
          checked={hibernation.enabled}
          onChange={(v) => set({ enabled: v })}
        />
        {hibernation.enabled ? (
          <>
            <NumberRow
              label={d.settings.hibernateIdle}
              desc={d.settings.hibernateIdleDesc}
              value={hibernation.idleSeconds}
              min={HIBERNATION_IDLE_MIN}
              max={HIBERNATION_IDLE_MAX}
              onCommit={(n) => set({ idleSeconds: n })}
            />
            <NumberRow
              label={d.settings.hibernateMaxLive}
              desc={d.settings.hibernateMaxLiveDesc}
              value={hibernation.maxLiveTerminals}
              min={0}
              max={HIBERNATION_LIVE_MAX}
              onCommit={(n) => set({ maxLiveTerminals: n })}
            />
            <Notice>{d.settings.hibernateNote}</Notice>
          </>
        ) : null}
      </SettingsGroup>
    </SettingsPage>
  )
}
