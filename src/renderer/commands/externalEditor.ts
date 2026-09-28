import type { ExternalEditorResult } from '@shared/types'
import { editorPositionOf } from '../lib/editorPositions'
import { useSettingsStore } from '../stores/settingsStore'
import { commands } from './registry'

export const OPEN_EXTERNAL_COMMAND = 'editor.openExternal'

export function openPaneInExternalEditor(paneId: string): Promise<ExternalEditorResult> | null {
  const position = editorPositionOf(paneId)
  if (!position) return null
  return window.pine.externalEditor.open({
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
  commands.register<undefined, { argv: string[] }>({
    id: OPEN_EXTERNAL_COMMAND,
    title: 'Open in External Editor',
    category: 'Editor',
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
