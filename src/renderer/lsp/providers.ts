import type {
  CompletionItem,
  CompletionList,
  Hover,
  Location,
  LocationLink,
  ServerCapabilities,
  TextEdit,
} from 'vscode-languageserver-protocol'
import { monaco } from '../monaco/setup'
import {
  type LspCompletion,
  markup,
  toCompletion,
  toHover,
  toLocations,
  toLspPosition,
  toTextEdits,
} from './converters'
import type { LspSession } from './session'

export type SessionLookup = (model: monaco.editor.ITextModel) => LspSession | undefined

interface SessionCompletion extends LspCompletion {
  session: LspSession
}

const TRIGGER_CHARACTER = 2
const TRIGGER_INVOKED = 1

function documentPosition(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): { textDocument: { uri: string }; position: { line: number; character: number } } {
  return { textDocument: { uri: model.uri.toString() }, position: toLspPosition(position) }
}

function completionProvider(
  capabilities: ServerCapabilities,
  sessionOf: SessionLookup,
): monaco.languages.CompletionItemProvider {
  const options = capabilities.completionProvider ?? {}
  return {
    triggerCharacters: options.triggerCharacters ?? [],
    async provideCompletionItems(model, position, context, token) {
      const session = sessionOf(model)
      if (!session) return { suggestions: [] }
      const result = await session.request<CompletionItem[] | CompletionList>(
        'textDocument/completion',
        {
          ...documentPosition(model, position),
          context:
            context.triggerCharacter !== undefined
              ? { triggerKind: TRIGGER_CHARACTER, triggerCharacter: context.triggerCharacter }
              : { triggerKind: TRIGGER_INVOKED },
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
  }
}

export function registerProviders(
  language: string,
  capabilities: ServerCapabilities,
  sessionOf: SessionLookup,
): monaco.IDisposable {
  const registrations: monaco.IDisposable[] = []
  const { languages } = monaco

  if (capabilities.completionProvider) {
    registrations.push(
      languages.registerCompletionItemProvider(
        language,
        completionProvider(capabilities, sessionOf),
      ),
    )
  }

  if (capabilities.hoverProvider) {
    registrations.push(
      languages.registerHoverProvider(language, {
        async provideHover(model, position, token) {
          const session = sessionOf(model)
          if (!session) return null
          return toHover(
            await session.request<Hover>(
              'textDocument/hover',
              documentPosition(model, position),
              token,
            ),
          )
        },
      }),
    )
  }

  if (capabilities.definitionProvider) {
    registrations.push(
      languages.registerDefinitionProvider(language, {
        async provideDefinition(model, position, token) {
          const session = sessionOf(model)
          if (!session) return null
          return toLocations(
            await session.request<Location | Location[] | LocationLink[]>(
              'textDocument/definition',
              documentPosition(model, position),
              token,
            ),
          )
        },
      }),
    )
  }

  if (capabilities.documentFormattingProvider) {
    registrations.push(
      languages.registerDocumentFormattingEditProvider(language, {
        async provideDocumentFormattingEdits(model, options, token) {
          const session = sessionOf(model)
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
      }),
    )
  }

  return {
    dispose: () => {
      for (const registration of registrations) registration.dispose()
    },
  }
}
