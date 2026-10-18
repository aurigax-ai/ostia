import type { FileChange } from '@shared/boards/git'
import { AREA_ORDER } from './gitView'

export interface ChangeRef {
  path: string
  area: FileChange['area']
}

export function orderedChanges(root: string, changes: readonly FileChange[]): ChangeRef[] {
  return AREA_ORDER.flatMap((area) =>
    changes.filter((c) => c.area === area).map((c) => ({ path: `${root}/${c.path}`, area })),
  )
}

export function neighborChange(
  list: readonly ChangeRef[],
  from: ChangeRef,
  step: 1 | -1,
): ChangeRef | null {
  const at = list.findIndex((c) => c.path === from.path && c.area === from.area)
  if (at < 0 || list.length < 2) return null
  return list[(at + step + list.length) % list.length]
}
