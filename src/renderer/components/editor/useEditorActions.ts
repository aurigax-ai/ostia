import type { Dict } from '@shared/app/dict'
import { type MutableRefObject, useEffect } from 'react'
import type { SelectionSend } from '@/components/agents/SelectionSend'
import { lineReference } from '@/lib/agents/fileReference'
import { registerSelectionSender } from '@/lib/agents/selectionSenders'
import { registerEditorPosition } from '@/lib/files/editorPositions'
import { useAskSelectionAction, useAssistCompletionsAction } from '@/lib/monaco/assistAction'
import { useLiveEditorSelection } from '@/lib/monaco/liveSelection'
import { editorSelectionAnchor } from '@/lib/monaco/selectionAnchor'
import type { monaco } from '@/lib/monaco/setup'
import type { PreviewSelection } from './MarkdownPreview'
import type { Blocked } from './useEditorFile'

interface SendSelectionParams {
  pathRef: MutableRefObject<string | undefined>
  blocked: Blocked | null
  markdown: boolean
  preview: boolean
  previewSelectionRef: MutableRefObject<PreviewSelection | null>
  selectionSend: Pick<SelectionSend, 'open' | 'notify'>
  d: Dict
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>
}

export function sendSelection({
  pathRef,
  blocked,
  markdown,
  preview,
  previewSelectionRef,
  selectionSend,
  d,
  editorRef,
}: SendSelectionParams): void {
  const file = pathRef.current
  if (!file || blocked) return
  if (markdown && preview) {
    const sel = previewSelectionRef.current
    if (!sel) {
      selectionSend.notify(d.viewer.noSelection)
      return
    }
    selectionSend.open({
      kind: 'text',
      file,
      view: 'preview',
      range: { startLine: sel.startLine, endLine: sel.endLine },
      text: sel.text,
    })
    return
  }
  const editor = editorRef.current
  const model = editor?.getModel()
  const sel = editor?.getSelection()
  if (!model || !sel || sel.isEmpty()) {
    selectionSend.notify(d.viewer.noSelection)
    return
  }
  selectionSend.open(
    {
      kind: 'text',
      file,
      view: 'source',
      range: {
        startLine: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLine: sel.endLineNumber,
        endColumn: sel.endColumn,
      },
      text: model.getValueInRange(sel),
    },
    undefined,
    editor ? editorSelectionAnchor(editor) : undefined,
  )
}

interface EditorActionsParams {
  d: Dict
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>
  pathRef: MutableRefObject<string | undefined>
  workspaceId: string
  paneId: string
  openExternalRef: MutableRefObject<() => void>
  sendSelectionRef: MutableRefObject<() => void>
}

export function useEditorActions({
  d,
  editorRef,
  pathRef,
  workspaceId,
  paneId,
  openExternalRef,
  sendSelectionRef,
}: EditorActionsParams): void {
  const openExternalLabel = d.editor.openExternal
  const sendSelectionLabel = d.viewer.sendSelection
  const copyLinesLabel = d.fileMenu.copyLines
  useAssistCompletionsAction(editorRef)
  useAskSelectionAction(editorRef, pathRef)
  useLiveEditorSelection(editorRef, pathRef, workspaceId, paneId)

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const unregister = registerEditorPosition(paneId, () => {
      const file = pathRef.current
      const pos = editor.getPosition()
      return file ? { file, line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 } : null
    })
    const action = editor.addAction({
      id: 'ostia.openExternal',
      label: openExternalLabel,
      contextMenuGroupId: 'navigation',
      run: () => openExternalRef.current(),
    })
    const sendAction = editor.addAction({
      id: 'ostia.sendSelection',
      label: sendSelectionLabel,
      contextMenuGroupId: 'navigation',
      precondition: 'editorHasSelection',
      run: () => sendSelectionRef.current(),
    })
    const copyLinesAction = editor.addAction({
      id: 'ostia.copyPathAndLines',
      label: copyLinesLabel,
      contextMenuGroupId: '9_cutcopypaste',
      run: () => {
        const file = pathRef.current
        const sel = editor.getSelection()
        if (!file || !sel) return
        const endLine =
          sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber
            ? sel.endLineNumber - 1
            : sel.endLineNumber
        void navigator.clipboard.writeText(lineReference(file, sel.startLineNumber, endLine))
      },
    })
    const unregisterSender = registerSelectionSender(paneId, () => sendSelectionRef.current())
    return () => {
      action.dispose()
      sendAction.dispose()
      copyLinesAction.dispose()
      unregisterSender()
      unregister()
    }
  }, [
    paneId,
    openExternalLabel,
    sendSelectionLabel,
    copyLinesLabel,
    editorRef,
    pathRef,
    openExternalRef,
    sendSelectionRef,
  ])
}
