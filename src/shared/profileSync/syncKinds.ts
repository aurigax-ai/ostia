export const SYNC_KINDS = ['settings', 'snippets', 'completions', 'views', 'extensions'] as const

export type SyncKind = (typeof SYNC_KINDS)[number]

export type SyncKinds = Record<SyncKind, boolean>

const flagsOf = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}

export function parseSyncKinds(raw: unknown): SyncKinds {
  const flags = flagsOf(raw)
  return Object.fromEntries(SYNC_KINDS.map((kind) => [kind, flags[kind] !== false])) as SyncKinds
}

export function offKinds(raw: unknown): Partial<SyncKinds> | undefined {
  const flags = flagsOf(raw)
  const off = SYNC_KINDS.filter((kind) => flags[kind] === false)
  return off.length > 0 ? Object.fromEntries(off.map((kind) => [kind, false])) : undefined
}
