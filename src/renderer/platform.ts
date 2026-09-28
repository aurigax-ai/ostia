import type { Platform } from '@shared/types'

export const platform: Platform = globalThis.window?.pine?.platform ?? 'linux'

export const isMac = platform === 'darwin'
