import type { OstiaExtension, Translate } from '@aurigax-ai/ostia-extension-sdk'
import { INBOX_ITEMS_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { Journal } from './journal'

const SIDEBAR_KEY = 'needs-you'

interface NeedsYouDeps {
  ext: OstiaExtension
  journal: Journal
  translate: (locale: string | undefined) => Translate
  state: { locale: string }
}

export function createNeedsYou(deps: NeedsYouDeps): () => Promise<void> {
  const { ext, journal, translate, state } = deps
  const counted = new Set<string>()
  let startsWithWindow: boolean | null = null
  const showNeedsYou = async (): Promise<void> => {
    const open = journal.workspaceIds().filter((id) => journal.openNeedsYou(id).length > 0)
    for (const workspaceId of new Set([...counted, ...open])) {
      const notes = journal.openNeedsYou(workspaceId)
      const count = notes.length
      if (count === 0) counted.delete(workspaceId)
      else counted.add(workspaceId)
      await ext
        .setInboxItems(
          workspaceId,
          notes.slice(0, INBOX_ITEMS_MAX).map((note) => ({
            id: note.id,
            text: note.text,
            paneId: note.pane,
            at: note.t,
          })),
        )
        .catch(() => {})
      await ext
        .setSidebarItem({
          key: SIDEBAR_KEY,
          workspaceId,
          text: count > 0 ? translate(state.locale)('needsYou') : '',
          badge: String(count),
          icon: 'alert',
          tone: 'warn',
        })
        .catch(() => {})
    }
    const keep = open.length > 0
    if (keep !== startsWithWindow) {
      startsWithWindow = keep
      await ext.startWithWindow(keep).catch(() => {})
    }
  }
  return showNeedsYou
}
