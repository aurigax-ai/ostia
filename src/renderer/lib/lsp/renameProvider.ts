import type { Range, RenameOptions, WorkspaceEdit } from 'vscode-languageserver-protocol'
import { currentDict } from '@/lib/app/useDict'
import { monaco } from '@/lib/monaco/setup'
import { toMonacoRange } from './converters'
import { documentPosition, type ProviderParams } from './providerParams'
import {
  applyClosedFileEdits,
  editsStayInside,
  openModelEdits,
  textEditsByUri,
} from './workspaceEdit'

interface RenameParams extends ProviderParams {
  options: boolean | RenameOptions
}

function fallbackWordRange(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): monaco.IRange {
  const word = model.getWordAtPosition(position)
  return {
    startLineNumber: position.lineNumber,
    startColumn: word?.startColumn ?? position.column,
    endLineNumber: position.lineNumber,
    endColumn: word?.endColumn ?? position.column,
  }
}

export function registerRename({ language, sessionOf, options }: RenameParams): monaco.IDisposable {
  const prepares = typeof options === 'object' && options.prepareProvider === true
  return monaco.languages.registerRenameProvider(language, {
    async provideRenameEdits(model, position, newName, token) {
      const session = sessionOf(model, 'textDocument/rename')
      if (!session) return { edits: [] }
      const edit = await session.request<WorkspaceEdit>(
        'textDocument/rename',
        { ...documentPosition(model, position), newName },
        token,
      )
      const byUri = edit ? textEditsByUri(edit) : null
      if (!byUri || !editsStayInside(byUri, session.info.editRoot))
        return { edits: [], rejectReason: currentDict().languageServers.renameRefused }
      await applyClosedFileEdits(byUri)
      return openModelEdits(byUri)
    },
    ...(prepares
      ? {
          async resolveRenameLocation(model, position, token) {
            const session = sessionOf(model, 'textDocument/rename')
            const prepared = session
              ? await session.request<
                  Range | { range: Range; placeholder: string } | { defaultBehavior: boolean }
                >('textDocument/prepareRename', documentPosition(model, position), token)
              : null
            if (!prepared)
              return {
                range: fallbackWordRange(model, position),
                text: '',
                rejectReason: currentDict().languageServers.renameRefused,
              }
            if ('defaultBehavior' in prepared) {
              const range = fallbackWordRange(model, position)
              return { range, text: model.getValueInRange(range) }
            }
            const range = toMonacoRange('range' in prepared ? prepared.range : prepared)
            return {
              range,
              text: 'placeholder' in prepared ? prepared.placeholder : model.getValueInRange(range),
            }
          },
        }
      : {}),
  })
}
