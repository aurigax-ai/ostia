import type { monaco } from './setup'

export function editorInput(
  editor: monaco.editor.ICodeEditor | null | undefined,
): HTMLElement | null {
  return (
    editor?.getDomNode()?.querySelector<HTMLElement>('.native-edit-context, textarea.inputarea') ??
    null
  )
}
