import type { Dict } from '../i18n/dict'
import type { MergeTarget } from './workspaceMerge'

export function mergeRefusalText(d: Dict, refusal: MergeTarget['refusal']): string | undefined {
  if (refusal === 'other-window') return d.merge.otherWindow
  return refusal ? d.merge[refusal] : undefined
}
