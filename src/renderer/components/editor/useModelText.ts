import type { monaco } from '@/lib/monaco/setup'
import { useEffect, useState } from 'react'

const PREVIEW_DEBOUNCE_MS = 150

export function useModelText(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  enabled: boolean,
): string {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!enabled || !editor) return
    let content: monaco.IDisposable | undefined
    let pending: ReturnType<typeof setTimeout> | undefined
    const follow = (): void => {
      content?.dispose()
      clearTimeout(pending)
      const model = editor.getModel()
      setText(model?.getValue() ?? '')
      content = model?.onDidChangeContent(() => {
        clearTimeout(pending)
        pending = setTimeout(() => setText(model.getValue()), PREVIEW_DEBOUNCE_MS)
      })
    }
    follow()
    const swap = editor.onDidChangeModel(follow)
    return () => {
      swap.dispose()
      content?.dispose()
      clearTimeout(pending)
    }
  }, [editor, enabled])
  return text
}
