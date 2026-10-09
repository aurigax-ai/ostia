import { editorPositionOf } from '@/lib/files/editorPositions'
import { isRemotePath } from '@shared/remoteFolders'
import type { ExternalEditorResult } from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import { registerCore } from './core'

export const OPEN_EXTERNAL_COMMAND = 'editor.openExternal'

export function openPaneInExternalEditor(paneId: string): Promise<ExternalEditorResult> | null {
  const position = editorPositionOf(paneId)
  if (!position || isRemotePath(position.file)) return null
  return window.ostia.externalEditor.open({
    template: useSettingsStore.getState().behavior.externalEditor,
    file: position.file,
    line: position.line,
    column: position.column,
  })
}

export function externalEditorError(res: ExternalEditorResult): string | null {
  if (res.ok) return null
  return res.message ? `${res.error}: ${res.message}` : res.error
}

export function registerExternalEditorCommand(): void {
  registerCore<undefined, { argv: string[] }>({
    id: OPEN_EXTERNAL_COMMAND,
    category: 'editor',
    target: 'active',
    run: async (_args, ctx) => {
      const pending = ctx.activePaneId ? openPaneInExternalEditor(ctx.activePaneId) : null
      if (!pending) throw new Error('the active pane has no file open')
      const res = await pending
      if (!res.ok) throw new Error(externalEditorError(res) ?? res.error)
      return { argv: res.argv }
    },
  })
}
