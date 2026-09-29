export const WORKSPACE_DESCRIPTION_MAX = 500

export function normalizeDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (!text) return undefined
  return text.length > WORKSPACE_DESCRIPTION_MAX
    ? `${text.slice(0, WORKSPACE_DESCRIPTION_MAX - 1)}…`
    : text
}
