import { useLiveSelectionStore } from '@/stores/terminal/liveSelectionStore'
import { CHAT_CONTEXT_TEXT_MAX } from '@shared/assist'
import { debounce } from 'es-toolkit'
import type * as monaco from 'monaco-editor'
import { type RefObject, useEffect } from 'react'

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
    const debouncedPublish = debounce(publish, LIVE_SELECTION_DELAY_MS)
    const subscription = editor.onDidChangeCursorSelection(() => {
      debouncedPublish()
    })
    return () => {
      debouncedPublish.cancel()
      subscription.dispose()
      useLiveSelectionStore.getState().clear(paneId)
    }
  }, [editorRef, pathRef, workspaceId, paneId])
}
