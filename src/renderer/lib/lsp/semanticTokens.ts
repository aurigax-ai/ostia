import type {
  SemanticTokens,
  SemanticTokensDelta,
  SemanticTokensOptions,
} from 'vscode-languageserver-protocol'
import { monaco } from '@/lib/monaco/setup'
import type { ProviderParams } from './providerParams'

interface SemanticTokensParams extends ProviderParams {
  options: SemanticTokensOptions
}

export function registerSemanticTokens({
  language,
  sessionOf,
  options,
}: SemanticTokensParams): monaco.IDisposable {
  const { legend } = options
  const deltas = typeof options.full === 'object' && options.full.delta === true
  return monaco.languages.registerDocumentSemanticTokensProvider(language, {
    getLegend: () => ({
      tokenTypes: [...legend.tokenTypes],
      tokenModifiers: [...legend.tokenModifiers],
    }),
    async provideDocumentSemanticTokens(model, lastResultId, token) {
      const session = sessionOf(model, 'textDocument/semanticTokens')
      if (!session) return null
      const textDocument = { uri: model.uri.toString() }
      const tokens =
        deltas && lastResultId
          ? await session.request<SemanticTokens | SemanticTokensDelta>(
              'textDocument/semanticTokens/full/delta',
              { textDocument, previousResultId: lastResultId },
              token,
            )
          : await session.request<SemanticTokens>(
              'textDocument/semanticTokens/full',
              { textDocument },
              token,
            )
      if (!tokens) return null
      if ('edits' in tokens) {
        return {
          resultId: tokens.resultId,
          edits: tokens.edits.map((change) => ({
            start: change.start,
            deleteCount: change.deleteCount,
            data: change.data ? new Uint32Array(change.data) : undefined,
          })),
        }
      }
      return { resultId: tokens.resultId, data: new Uint32Array(tokens.data) }
    },
    releaseDocumentSemanticTokens: () => {},
  })
}
