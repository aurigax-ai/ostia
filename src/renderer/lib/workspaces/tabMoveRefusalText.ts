import type { Dict } from '@shared/app/dict'
import type { TabMoveRefusal } from './tabWorkspaceMove'

export function tabMoveRefusalText(d: Dict, refusal: TabMoveRefusal | null): string | undefined {
  return refusal ? d.tabMove[refusal] : undefined
}
