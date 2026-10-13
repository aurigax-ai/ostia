export const WORKSPACE_GROUP_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
] as const

export type WorkspaceGroupColor = (typeof WORKSPACE_GROUP_COLORS)[number]

export const WORKSPACE_GROUP_NAME_MAX = 60

export function isWorkspaceGroupColor(value: unknown): value is WorkspaceGroupColor {
  return (WORKSPACE_GROUP_COLORS as readonly unknown[]).includes(value)
}

export function normalizeGroupName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim().slice(0, WORKSPACE_GROUP_NAME_MAX).trim()
  return name || undefined
}
