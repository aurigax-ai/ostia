import { CHAT_CONTEXT_TEXT_MAX } from '@shared/assist'
import type * as monaco from 'monaco-editor'
import { type RefObject, useEffect } from 'react'
import { useLiveSelectionStore } from '../stores/liveSelectionStore'

export const LIVE_SELECTION_DELAY_MS = 150

export function useLiveEditorSelection(
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>,
  pathRef: RefObject<string | undefined>,
  workspaceId: string,
  paneId: string,
): void {
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const publish = (): void => {
      const selection = editor.getSelection()
      const model = editor.getModel()
      const file = pathRef.current
      const { report, clear } = useLiveSelectionStore.getState()
      const empty =
        !selection ||
        (selection.startLineNumber === selection.endLineNumber &&
          selection.startColumn === selection.endColumn)
      if (!selection || !model || !file || empty) {
        clear(paneId)
        return
      }
      const endLine =
        selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
          ? selection.endLineNumber - 1
          : selection.endLineNumber
      report(
        workspaceId,
        paneId,
        { kind: 'editor', file, startLine: selection.startLineNumber, endLine },
        model.getValueInRange(selection).slice(0, CHAT_CONTEXT_TEXT_MAX),
      )
    }
    const subscription = editor.onDidChangeCursorSelection(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(publish, LIVE_SELECTION_DELAY_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      subscription.dispose()
      useLiveSelectionStore.getState().clear(paneId)
    }
  }, [editorRef, pathRef, workspaceId, paneId])
}
