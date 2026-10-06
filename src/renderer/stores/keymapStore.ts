import type { ExtensionInfo } from '@shared/extensions'
import { appKeymapIn } from '@shared/keyboardPresets'
import { type KeymapInfo, keymapOffered, keymapRef } from '@shared/keymap'
import type { LoadedKeymap } from '@shared/keymapFile'
import { create } from 'zustand'
import { platform } from '../platform'
import { useExtensionsStore } from './extensionsStore'
import { useSettingsStore } from './settingsStore'

export interface KeymapChoice {
  ref: string
  label: string
  extName: string
}

interface KeymapState {
  key: string | null
  ref: string | null
  loaded: LoadedKeymap | null
  error: string | null
  load: (ref: string | null, key: string | null) => Promise<void>
}

export const useKeymapStore = create<KeymapState>((set, get) => ({
  key: null,
  ref: null,
  loaded: null,
  error: null,
  load: async (ref, key) => {
    if (get().key === key) return
    set({ key, ref, loaded: null, error: null })
    if (!ref || !key) return
    let res: Awaited<ReturnType<typeof window.ostia.keymaps.load>>
    try {
      res = await window.ostia.keymaps.load(ref)
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (get().key !== key) return
    if (res.ok) set({ loaded: res.keymap })
    else set({ error: res.error })
  },
}))

export function keymapChoices(list: readonly ExtensionInfo[], on: string): KeymapChoice[] {
  const out: KeymapChoice[] = []
  for (const ext of list) {
    if (!ext.enabled) continue
    for (const keymap of ext.keymaps ?? []) {
      if (keymapOffered(keymap, on)) {
        out.push({ ref: keymapRef(ext.id, keymap.id), label: keymap.label, extName: ext.name })
      }
    }
  }
  return out
}

export function keymapProvider(
  ref: string | null,
  list: readonly ExtensionInfo[],
  on: string,
): { ext: ExtensionInfo; keymap: KeymapInfo } | null {
  if (!ref) return null
  for (const ext of list) {
    if (!ext.enabled) continue
    const keymap = (ext.keymaps ?? []).find(
      (k) => keymapRef(ext.id, k.id) === ref && keymapOffered(k, on),
    )
    if (keymap) return { ext, keymap }
  }
  return null
}

export function appKeymap(): string {
  return appKeymapIn(useSettingsStore.getState().keymap, { platform })
}

function syncKeymap(): void {
  const ref = appKeymap()
  const provider = keymapProvider(ref, useExtensionsStore.getState().list, platform)
  const key = provider ? `${ref}\n${provider.ext.version}` : null
  void useKeymapStore.getState().load(provider ? ref : null, key)
}

export function startKeymapSync(): () => void {
  syncKeymap()
  const offSettings = useSettingsStore.subscribe((s, prev) => {
    if (s.keymap !== prev.keymap) syncKeymap()
  })
  const offExtensions = useExtensionsStore.subscribe((s, prev) => {
    if (s.list !== prev.list) syncKeymap()
  })
  return () => {
    offSettings()
    offExtensions()
  }
}
