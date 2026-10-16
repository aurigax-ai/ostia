import { ControlRow, NumberRow, ToggleRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Input } from '@/components/ui/input'
import { useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import {
  BELL_MODES,
  type BellMode,
  LONG_COMMAND_MAX_SECONDS,
  LONG_COMMAND_MIN_SECONDS,
  clampLongCommandSeconds,
} from '@shared/app/notificationSettings'

export function NotificationsSection(): JSX.Element {
  const d = useDict()
  const n = useSettingsStore((s) => s.notifications)
  const set = useSettingsStore((s) => s.setNotifications)
  const bellLabel: Record<BellMode, string> = {
    attention: d.settings.bellAttention,
    sound: d.settings.bellSound,
    off: d.settings.bellOff,
  }
  return (
    <SettingsPage title={d.settings.notifications}>
      <SettingsGroup title={d.settings.groupDesktop}>
        <ToggleRow
          label={d.settings.notifyDesktop}
          desc={d.settings.notifyDesktopDesc}
          checked={n.desktop}
          onChange={(v) => set({ desktop: v })}
        />
        <ToggleRow
          label={d.settings.notifySound}
          desc={d.settings.notifySoundDesc}
          checked={n.sound}
          onChange={(v) => set({ sound: v })}
        />
        <ToggleRow
          label={d.settings.notifyWhenFocused}
          desc={d.settings.notifyWhenFocusedDesc}
          checked={n.whenFocused}
          onChange={(v) => set({ whenFocused: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupCommand}>
        <ControlRow label={d.settings.notifyCommand} desc={d.settings.notifyCommandDesc}>
          <Input
            value={n.command}
            spellCheck={false}
            aria-label={d.settings.notifyCommand}
            onChange={(e) => set({ command: e.target.value })}
            className="h-7 w-56 font-mono"
          />
        </ControlRow>
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupEvents}>
        <ToggleRow
          label={d.settings.notifyAgentWaiting}
          desc={d.settings.notifyAgentWaitingDesc}
          checked={n.agentWaiting}
          onChange={(v) => set({ agentWaiting: v })}
        />
        <ToggleRow
          label={d.settings.notifyAgentDone}
          desc={d.settings.notifyAgentDoneDesc}
          checked={n.agentDone}
          onChange={(v) => set({ agentDone: v })}
        />
        <ToggleRow
          label={d.settings.notifyCommandFinished}
          desc={d.settings.notifyCommandFinishedDesc}
          checked={n.commandFinished}
          onChange={(v) => set({ commandFinished: v })}
        />
        <NumberRow
          label={d.settings.longCommandSeconds}
          desc={d.settings.longCommandSecondsDesc}
          value={n.longCommandSeconds}
          min={LONG_COMMAND_MIN_SECONDS}
          max={LONG_COMMAND_MAX_SECONDS}
          onCommit={(v) => set({ longCommandSeconds: clampLongCommandSeconds(v) })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupBell}>
        <ControlRow label={d.settings.bell} desc={d.settings.bellDesc}>
          <SelectField
            value={n.bell}
            onChange={(v) => set({ bell: v })}
            label={d.settings.bell}
            options={BELL_MODES.map((m) => ({ value: m, label: bellLabel[m] }))}
          />
        </ControlRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
