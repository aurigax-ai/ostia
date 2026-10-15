import type { monaco } from '@/lib/monaco/setup'
import { toLspPosition } from './converters'
import type { LspSession } from './session'

export type SessionLookup = (
  model: monaco.editor.ITextModel,
  method: string,
) => LspSession | undefined

export interface ProviderParams {
  language: string
  sessionOf: SessionLookup
}

export function documentPosition(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): { textDocument: { uri: string }; position: { line: number; character: number } } {
  return { textDocument: { uri: model.uri.toString() }, position: toLspPosition(position) }
}
