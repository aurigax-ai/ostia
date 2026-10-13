import { useSettingsStore } from '@/stores/app/settingsStore'
import { BUILTIN_ICON_THEME, type IconThemeInfo, type LoadedIconTheme } from '@shared/iconTheme'
import { useEffect } from 'react'
import { create } from 'zustand'
import { useExtensionsStore } from './extensionsStore'

interface IconThemeState {
  key: string | null
  theme: LoadedIconTheme | null
  load: (id: string, key: string) => Promise<void>
}

export const useIconThemeStore = create<IconThemeState>((set, get) => ({
  key: null,
  theme: null,
  load: async (id, key) => {
    if (get().key === key) return
    set({ key, theme: null })
    const theme = await window.ostia.iconThemes.load(id)
    if (get().key === key) set({ theme })
  },
}))

export function useAvailableIconThemes(): IconThemeInfo[] {
  const list = useExtensionsStore((s) => s.list)
  const seen = new Set<string>()
  const out: IconThemeInfo[] = []
  for (const ext of list) {
    if (!ext.enabled) continue
    for (const theme of ext.iconThemes) {
      if (seen.has(theme.id)) continue
      seen.add(theme.id)
      out.push(theme)
    }
  }
  return out
}

export function useActiveIconTheme(): LoadedIconTheme | null {
  const id = useSettingsStore((s) => s.files.iconTheme)
  const list = useExtensionsStore((s) => s.list)
  const provider = list.find((ext) => ext.enabled && ext.iconThemes.some((t) => t.id === id))
  const key =
    id === BUILTIN_ICON_THEME || !provider ? null : `${id}\n${provider.id}\n${provider.version}`
  const theme = useIconThemeStore((s) => (key && s.key === key ? s.theme : null))
  useEffect(() => {
    if (key) void useIconThemeStore.getState().load(id, key)
  }, [id, key])
  return theme
}
