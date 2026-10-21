import type { ModifierRemap } from '@shared/keyboard/modifierRemap'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { installModifierRemap, setActiveModifierRemap } from './modifierRemapEvents'

export function startModifierRemap(mac: boolean): () => void {
  const uninstall = installModifierRemap()
  const apply = (stored: ModifierRemap): void => {
    const table = mac ? stored : {}
    setActiveModifierRemap(table)
    window.ostia.guestChords.setRemap(table)
  }
  apply(useSettingsStore.getState().modifierRemap)
  const unsubscribe = useSettingsStore.subscribe((s, prev) => {
    if (s.modifierRemap !== prev.modifierRemap) apply(s.modifierRemap)
  })
  return () => {
    unsubscribe()
    uninstall()
  }
}
