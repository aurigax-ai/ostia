type GhosttyModule = typeof import('./ghosttyTerminal')

let loaded: GhosttyModule | null = null
let loading: Promise<GhosttyModule> | null = null
let failure: string | null = null

export function ghosttyModule(): GhosttyModule | null {
  return loaded
}

export function ghosttyFailure(): string | null {
  return failure
}

export function loadGhostty(): Promise<GhosttyModule> {
  loading ??= import('./ghosttyTerminal').then(async (mod) => {
    await mod.loadGhosttyEngine()
    loaded = mod
    failure = null
    return mod
  })
  loading.catch((err: unknown) => {
    failure = err instanceof Error ? err.message : String(err)
    loading = null
  })
  return loading
}
