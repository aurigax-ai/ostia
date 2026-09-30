import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

export function loadWebglRenderer(term: Terminal): boolean {
  const addon = new WebglAddon()
  try {
    term.loadAddon(addon)
  } catch {
    addon.dispose()
    return false
  }
  addon.onContextLoss(() => addon.dispose())
  return true
}
