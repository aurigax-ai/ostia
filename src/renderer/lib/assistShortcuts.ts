import { commands } from '../commands/registry'
import { isMac } from '../platform'
import { useSettingsStore } from '../stores/settingsStore'
import { bindableIds, chordLabel } from './chords'

export function shortcutMap(mac: boolean): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of bindableIds()) {
    const label = chordLabel(id, mac)
    if (label) out[id] = label
  }
  return out
}

export function startShortcutReporting(): () => void {
  let last = ''
  const report = (): void => {
    const map = shortcutMap(isMac)
    const key = JSON.stringify(map)
    if (key === last) return
    last = key
    window.pine?.assist?.reportShortcuts?.(map)
  }
  report()
  const offCommands = commands.subscribe(report)
  const offSettings = useSettingsStore.subscribe((s, prev) => {
    if (s.keybindings !== prev.keybindings) report()
  })
  return () => {
    offCommands()
    offSettings()
  }
}
