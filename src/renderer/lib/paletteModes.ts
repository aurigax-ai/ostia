export type PaletteMode = 'all' | 'help' | 'commands' | 'workspaces' | 'tabs' | 'symbols'

export const SYMBOLS_PREFIX = '%'
export const GO_TO_WORKSPACE_SYMBOL_COMMAND = 'view.goToWorkspaceSymbol'

export const PALETTE_MODES: readonly {
  mode: Exclude<PaletteMode, 'all' | 'help'>
  symbol: string
}[] = [
  { mode: 'commands', symbol: '>' },
  { mode: 'workspaces', symbol: '@' },
  { mode: 'tabs', symbol: '#' },
  { mode: 'symbols', symbol: SYMBOLS_PREFIX },
]

export function paletteQuery(search: string): string {
  return search.trimStart().slice(1).trim()
}

export function paletteMode(search: string): PaletteMode {
  const first = search.trimStart()[0]
  if (first === '?') return 'help'
  return PALETTE_MODES.find((m) => m.symbol === first)?.mode ?? 'all'
}
