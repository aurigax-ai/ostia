import { debounce } from 'es-toolkit'
import { useEffect, useState } from 'react'
import type { monaco } from '@/lib/monaco/setup'

const PREVIEW_DEBOUNCE_MS = 150

export function useModelText(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  enabled: boolean,
): string {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!enabled || !editor) return
    let content: monaco.IDisposable | undefined
    const readLater = debounce(
      (model: monaco.editor.ITextModel) => setText(model.getValue()),
      PREVIEW_DEBOUNCE_MS,
    )
    const follow = (): void => {
      content?.dispose()
      readLater.cancel()
      const model = editor.getModel()
      setText(model?.getValue() ?? '')
      content = model?.onDidChangeContent(() => readLater(model))
    }
    follow()
    const swap = editor.onDidChangeModel(follow)
    return () => {
      swap.dispose()
      content?.dispose()
      readLater.cancel()
    }
  }, [editor, enabled])
  return text
}
