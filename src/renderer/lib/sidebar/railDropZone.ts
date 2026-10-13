export type RowDropZone = 'before' | 'after' | 'merge' | 'tab'

export type RailDragKind = 'workspace' | 'tab'

export const MERGE_ZONE_EDGE = 0.3

export function rowDropZone(
  kind: RailDragKind,
  fraction: number,
  accepts: boolean,
): RowDropZone | null {
  if (kind === 'tab') return accepts ? 'tab' : null
  if (!accepts) return fraction < 0.5 ? 'before' : 'after'
  if (fraction < MERGE_ZONE_EDGE) return 'before'
  if (fraction > 1 - MERGE_ZONE_EDGE) return 'after'
  return 'merge'
}
