export type FindKey = 'open' | 'next' | 'previous'

export function findKeyOf(event: KeyboardEvent, mac: boolean): FindKey | null {
  if (event.key === 'F3') return event.shiftKey ? 'previous' : 'next'
  const primary = mac ? event.metaKey : event.ctrlKey
  if (!primary || event.altKey) return null
  const key = event.key.toLowerCase()
  if (key === 'f' && !event.shiftKey) return 'open'
  if (key === 'g') return event.shiftKey ? 'previous' : 'next'
  return null
}
