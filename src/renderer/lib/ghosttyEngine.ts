type GhosttyModule = typeof import('./ghosttyTerminal')

let loaded: GhosttyModule | null = null
let loading: Promise<GhosttyModule> | null = null

export function ghosttyModule(): GhosttyModule | null {
  return loaded
}

export function loadGhostty(): Promise<GhosttyModule> {
  loading ??= import('./ghosttyTerminal').then(async (mod) => {
    await mod.loadGhosttyEngine()
    loaded = mod
    return mod
  })
  loading.catch(() => {
    loading = null
  })
  return loading
}
