import { SCROLLBAR_SIZE_PX } from '@aurigax-ai/ostia-extension-sdk/contract/scrollbar'
import type * as Monaco from 'monaco-editor'

export const EDITOR_SCROLLBAR: Monaco.editor.IEditorScrollbarOptions = {
  vertical: 'auto',
  horizontal: 'auto',
  verticalScrollbarSize: SCROLLBAR_SIZE_PX,
  horizontalScrollbarSize: SCROLLBAR_SIZE_PX,
  verticalHasArrows: false,
  horizontalHasArrows: false,
  useShadows: false,
}
