import type { Dict } from '../i18n/dict'
import type { TabMoveRefusal } from './tabWorkspaceMove'

export function tabMoveRefusalText(d: Dict, refusal: TabMoveRefusal | null): string | undefined {
  return refusal ? d.tabMove[refusal] : undefined
}
