import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'
import { countUsage } from './usageCounts'

export function loadWebglRenderer(term: Terminal): boolean {
  const addon = new WebglAddon()
  try {
    term.loadAddon(addon)
  } catch {
    addon.dispose()
    countUsage('terminal', 'webgl_fallback')
    return false
  }
  addon.onContextLoss(() => {
    addon.dispose()
    countUsage('terminal', 'webgl_fallback')
  })
  return true
}
