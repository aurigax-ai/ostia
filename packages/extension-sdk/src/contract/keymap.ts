export const KEYMAP_PLATFORMS = ['darwin', 'linux'] as const

export type KeymapPlatform = (typeof KEYMAP_PLATFORMS)[number]

export const KEYMAP_LABEL_MAX = 40

export interface KeymapContribution {
  id: string
  label: string
  path: string
  platform?: KeymapPlatform
}

export interface KeymapInfo {
  id: string
  label: string
  platform?: KeymapPlatform
}

export function keymapRef(extId: string, id: string): string {
  return `${extId}/${id}`
}

export function isKeymapPlatform(value: unknown): value is KeymapPlatform {
  return KEYMAP_PLATFORMS.includes(value as KeymapPlatform)
}

export function keymapOffered(keymap: { platform?: KeymapPlatform }, platform: string): boolean {
  return keymap.platform === undefined || keymap.platform === platform
}
