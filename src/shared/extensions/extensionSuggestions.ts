import type { MarketplaceResult } from './marketplace'

export interface ExtensionSuggestionRule {
  names: readonly string[]
  suffixes: readonly string[]
}

export const EXTENSION_SUGGESTIONS: Readonly<Record<string, ExtensionSuggestionRule>> = {
  'lsp-typescript': {
    names: [],
    suffixes: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
  },
  'lsp-pyright': { names: [], suffixes: ['py', 'pyi'] },
  'lsp-rust-analyzer': { names: [], suffixes: ['rs'] },
  'lsp-gopls': { names: ['go.mod', 'go.work'], suffixes: ['go'] },
  'lsp-clangd': { names: [], suffixes: ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh'] },
  'lsp-lua': { names: [], suffixes: ['lua'] },
  'lsp-yaml': { names: [], suffixes: ['yaml', 'yml'] },
  'lsp-bash': { names: [], suffixes: ['sh', 'bash'] },
  'lsp-marksman': { names: [], suffixes: ['md'] },
}

export interface SuggestedExtension {
  extId: string
  files: string
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function fileSuffix(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function filesLabel(path: string): string {
  const suffix = fileSuffix(path)
  return suffix ? `.${suffix}` : fileName(path)
}

export function suggestedExtension(
  path: string,
  table: Readonly<Record<string, ExtensionSuggestionRule>> = EXTENSION_SUGGESTIONS,
): SuggestedExtension | null {
  const name = fileName(path)
  for (const [extId, rule] of Object.entries(table)) {
    if (rule.names.includes(name)) return { extId, files: name }
  }
  const suffix = fileSuffix(path)
  if (!suffix) return null
  for (const [extId, rule] of Object.entries(table)) {
    if (rule.suffixes.includes(suffix)) return { extId, files: `.${suffix}` }
  }
  return null
}

type SuggestionFeature = 'language' | 'view'

export type ExtensionSuggestion = {
  feature: SuggestionFeature
  extId: string
  name: string
  files: string
  others: number
} & ({ kind: 'install' } | { kind: 'enable'; pending: boolean })

export interface SuggestionsApi {
  forFile: (paneId: string, path: string) => Promise<ExtensionSuggestion | null>
  dismiss: (extId: string) => Promise<void>
  install: (extId: string) => Promise<MarketplaceResult>
}
