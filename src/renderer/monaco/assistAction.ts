import { type RefObject, useEffect } from 'react'
import { useDict } from '../i18n/useDict'
import { setAssistFeature, useAssistFeature } from '../lib/assistFeatureSwitch'
import type { monaco } from './setup'

export const ASSIST_COMPLETIONS_ACTION_ID = 'pine.assist.toggleEditorCompletions'

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
