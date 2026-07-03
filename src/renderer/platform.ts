import type { Platform } from '@shared/types'

/**
 * OS platform, read once from the preload bridge. Guarded so non-Electron contexts
 * (e.g. unit tests importing a component) fall back to a sane default instead of throwing.
 */
export const platform: Platform = globalThis.window?.pine?.platform ?? 'linux'

/** macOS keeps native traffic lights (left); other OSes get our own controls (right). */
export const isMac = platform === 'darwin'
