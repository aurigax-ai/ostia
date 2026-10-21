import type { TextEdit } from 'vscode-languageserver-protocol'
import { monaco } from '@/lib/monaco/setup'
import { toLspRange, toTextEdits } from './converters'
import type { ProviderParams } from './providerParams'

export function registerDocumentFormatting({
  language,
  sessionOf,
}: ProviderParams): monaco.IDisposable {
  return monaco.languages.registerDocumentFormattingEditProvider(language, {
    async provideDocumentFormattingEdits(model, options, token) {
      const session = sessionOf(model, 'textDocument/formatting')
      if (!session) return null
      return toTextEdits(
        await session.request<TextEdit[]>(
          'textDocument/formatting',
          {
            textDocument: { uri: model.uri.toString() },
            options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
          },
          token,
        ),
      )
    },
  })
}

export function registerRangeFormatting({
  language,
  sessionOf,
}: ProviderParams): monaco.IDisposable {
  return monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
    async provideDocumentRangeFormattingEdits(model, range, options, token) {
      const session = sessionOf(model, 'textDocument/rangeFormatting')
      if (!session) return null
      return toTextEdits(
        await session.request<TextEdit[]>(
          'textDocument/rangeFormatting',
          {
            textDocument: { uri: model.uri.toString() },
            range: toLspRange(range),
            options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
          },
          token,
        ),
      )
    },
  })
}
