import { debounce } from 'es-toolkit'
import { monaco } from '@/lib/monaco/setup'
import { useEditorStatus } from '@/stores/files/editorStatusStore'
import { isDirty, uriFor } from './editorModels'

export const LIVE_TEXT_DEBOUNCE_MS = 150

export function followLiveDocument(paneId: string, filePath: string): () => void {
  const uri = uriFor(filePath)
  let model = monaco.editor.getModel(uri)
  let content: monaco.IDisposable | undefined
  const send = (text: string | null): void =>
    window.ostia.viewers.sendDocumentText({ paneId, path: filePath, text })
  const push = (): void => {
    send(model && !model.isDisposed() && isDirty(model) ? model.getValue() : null)
  }
  const pushLater = debounce(push, LIVE_TEXT_DEBOUNCE_MS)
  const follow = (next: monaco.editor.ITextModel | null): void => {
    content?.dispose()
    model = next
    content = next?.onDidChangeContent(pushLater)
  }
  follow(model)
  const created = monaco.editor.onDidCreateModel((next) => {
    if (next.uri.toString() !== uri.toString()) return
    follow(next)
    pushLater()
  })
  const unsubscribe = useEditorStatus.subscribe((state, previous) => {
    if (state.dirty[filePath] !== previous.dirty[filePath]) pushLater()
  })
  push()
  return () => {
    pushLater.cancel()
    created.dispose()
    content?.dispose()
    unsubscribe()
    send(null)
  }
}
