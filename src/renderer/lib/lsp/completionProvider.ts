import type {
  CompletionItem,
  CompletionList,
  CompletionOptions,
} from 'vscode-languageserver-protocol'
import { monaco } from '@/lib/monaco/setup'
import { type LspCompletion, markup, toCompletion, toTextEdits } from './converters'
import { documentPosition, type ProviderParams } from './providerParams'
import type { LspSession } from './session'

const COMPLETION_INVOKED = 1
const COMPLETION_TRIGGER_CHARACTER = 2

interface SessionCompletion extends LspCompletion {
  session: LspSession
}

interface CompletionParams extends ProviderParams {
  options: CompletionOptions
}

export function registerCompletion({
  language,
  sessionOf,
  options,
}: CompletionParams): monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: options.triggerCharacters ?? [],
    async provideCompletionItems(model, position, context, token) {
      const session = sessionOf(model, 'textDocument/completion')
      if (!session) return { suggestions: [] }
      const result = await session.request<CompletionItem[] | CompletionList>(
        'textDocument/completion',
        {
          ...documentPosition(model, position),
          context:
            context.triggerCharacter !== undefined
              ? {
                  triggerKind: COMPLETION_TRIGGER_CHARACTER,
                  triggerCharacter: context.triggerCharacter,
                }
              : { triggerKind: COMPLETION_INVOKED },
        },
        token,
      )
      if (!result) return { suggestions: [] }
      const list = Array.isArray(result) ? { isIncomplete: false, items: result } : result
      const word = model.getWordUntilPosition(position)
      const fallback: monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      }
      const defaults = list.itemDefaults ?? {}
      return {
        incomplete: list.isIncomplete === true,
        suggestions: list.items.map(
          (item): SessionCompletion => ({ ...toCompletion(item, fallback, defaults), session }),
        ),
      }
    },
    ...(options.resolveProvider
      ? {
          async resolveCompletionItem(item, token) {
            const { lspItem, session } = item as Partial<SessionCompletion>
            if (!lspItem || !session) return item
            const resolved = await session.request<CompletionItem>(
              'completionItem/resolve',
              lspItem,
              token,
            )
            if (!resolved) return item
            const documentation = markup(resolved.documentation)
            return {
              ...item,
              ...(resolved.detail ? { detail: resolved.detail } : {}),
              ...(documentation !== undefined ? { documentation } : {}),
              ...(resolved.additionalTextEdits
                ? { additionalTextEdits: toTextEdits(resolved.additionalTextEdits) }
                : {}),
            }
          },
        }
      : {}),
  })
}
