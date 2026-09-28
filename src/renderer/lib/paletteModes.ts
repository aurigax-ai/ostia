export type PaletteMode = 'all' | 'help' | 'commands' | 'workspaces' | 'tabs'

export const PALETTE_MODES: readonly {
  mode: Exclude<PaletteMode, 'all' | 'help'>
  symbol: string
}[] = [
  { mode: 'commands', symbol: '>' },
  { mode: 'workspaces', symbol: '@' },
  { mode: 'tabs', symbol: '#' },
]

export function paletteMode(search: string): PaletteMode {
  const first = search.trimStart()[0]
  if (first === '?') return 'help'
  return PALETTE_MODES.find((m) => m.symbol === first)?.mode ?? 'all'
}
