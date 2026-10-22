import type { DevSource } from '@shared/extensions/marketplace'

export function parseDevSource(input: string): DevSource | null {
  const text = input.trim()
  if (!text) return null
  if (text.startsWith('/')) return { kind: 'folder', path: text }
  const hash = text.lastIndexOf('#')
  if (hash <= 0) return null
  const url = text.slice(0, hash)
  const rest = text.slice(hash + 1)
  const colon = rest.indexOf(':')
  const branch = colon === -1 ? rest : rest.slice(0, colon)
  const path = colon === -1 ? '' : rest.slice(colon + 1)
  if (!branch) return null
  return { kind: 'git', url, branch, ...(path ? { path } : {}) }
}
