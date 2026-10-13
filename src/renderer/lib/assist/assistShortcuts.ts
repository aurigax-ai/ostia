import { commands } from '@/commands/registry'
import { bindableIds, chordLabel, onBindingsChange } from '@/lib/keys/chords'
import { isMac } from '@/platform'

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
    window.ostia?.assist?.reportShortcuts?.(map)
  }
  report()
  const offCommands = commands.subscribe(report)
  const offBindings = onBindingsChange(report)
  return () => {
    offCommands()
    offBindings()
  }
}
