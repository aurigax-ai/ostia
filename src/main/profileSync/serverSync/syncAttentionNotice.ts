import { type Dict, fmt } from '../../../shared/app/dict'
import type { SyncAttention } from '../../../shared/profileSync/serverSync'

export function attentionText(
  text: Dict['native']['syncAttention'],
  item: SyncAttention,
): { title: string; body: string } {
  switch (item.kind) {
    case 'join':
      return { title: text.join.title, body: fmt(text.join.body, { name: item.name }) }
    case 'approval':
      return { title: text.approval.title, body: fmt(text.approval.body, { name: item.name }) }
    case 'changed':
      return { title: text.changed.title, body: fmt(text.changed.body, { name: item.name }) }
  }
}

export function attentionPage(item: SyncAttention): 'server' | 'sync' {
  return item.kind === 'join' ? 'sync' : 'server'
}
