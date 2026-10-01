export type RowDropZone = 'before' | 'after' | 'merge'

export const MERGE_ZONE_EDGE = 0.3

export function rowDropZone(fraction: number, mergeable: boolean): RowDropZone {
  if (!mergeable) return fraction < 0.5 ? 'before' : 'after'
  if (fraction < MERGE_ZONE_EDGE) return 'before'
  if (fraction > 1 - MERGE_ZONE_EDGE) return 'after'
  return 'merge'
}
