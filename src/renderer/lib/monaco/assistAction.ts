import { CHAT_CONTEXT_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { type RefObject, useEffect } from 'react'
import { addToAgentPane } from '@/lib/agent/agentPane'
import { fmt, useDict } from '@/lib/app/useDict'
import { setAssistFeature, useAssistFeature } from '@/lib/assist/assistFeatures'
import type { monaco } from './setup'

const ASSIST_COMPLETIONS_ACTION_ID = 'ostia.assist.toggleEditorCompletions'
const ASK_SELECTION_ACTION_ID = 'ostia.assist.askAboutSelection'

export function useAssistCompletionsAction(
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>,
): void {
  const d = useDict()
  const ref = useAssistFeature('editorCompletions')
  const on = ref?.feature.on
  const label = on ? d.terminalGhost.editorOn : d.terminalGhost.editorOff
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || on === undefined) return
    const action = editor.addAction({
      id: ASSIST_COMPLETIONS_ACTION_ID,
      label,
      contextMenuGroupId: '9_assist',
      run: () => void setAssistFeature('editorCompletions', !on),
    })
    return () => action.dispose()
  }, [editorRef, on, label])
}

function askAboutEditorSelection(
  editor: monaco.editor.IStandaloneCodeEditor,
  path: string | null | undefined,
  label: string,
): boolean {
  const selection = editor.getSelection()
  const model = editor.getModel()
  if (!selection || !model) return false
  const text = model.getValueInRange(selection)
  if (!text.trim()) return false
  const file = path ?? model.uri.path
  const endLine =
    selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? selection.endLineNumber - 1
      : selection.endLineNumber
  return addToAgentPane({
    kind: 'selection',
    label: fmt(label, { path: file, line: selection.startLineNumber }),
    text: text.slice(0, CHAT_CONTEXT_TEXT_MAX),
    path: file,
    startLine: selection.startLineNumber,
    endLine,
  })
}

export function useAskSelectionAction(
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>,
  pathRef: RefObject<string | undefined>,
): void {
  const d = useDict()
  const label = d.agentPane.addToPane
  const itemLabel = d.chatActions.selectionIn
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const action = editor.addAction({
      id: ASK_SELECTION_ACTION_ID,
      label,
      contextMenuGroupId: '9_assist',
      precondition: 'editorHasSelection',
      run: () => {
        askAboutEditorSelection(editor, pathRef.current, itemLabel)
      },
    })
    return () => action.dispose()
  }, [editorRef, pathRef, label, itemLabel])
}
