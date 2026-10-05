import type { Platform } from '@shared/types'

export const platform: Platform = globalThis.window?.ostia?.platform ?? 'linux'

export const isMac = platform === 'darwin'

export const isLinux = platform === 'linux'
