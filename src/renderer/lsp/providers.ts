import type {
  CodeAction,
  Command,
  CompletionItem,
  CompletionList,
  DocumentHighlight,
  DocumentSymbol,
  Hover,
  InlayHint,
  Location,
  LocationLink,
  Range,
  SemanticTokens,
  ServerCapabilities,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver-protocol'
import { currentDict } from '../i18n/useDict'
import { monaco } from '../monaco/setup'
import {
  type LspCompletion,
  markup,
  rangesOverlap,
  toCompletion,
  toDocumentSymbols,
  toHighlights,
  toHover,
  toInlayHints,
  toLocations,
  toLspPosition,
  toLspRange,
  toMarkers,
  toMonacoRange,
  toSignatureHelp,
  toTextEdits,
} from './converters'
import type { LspSession } from './session'
import {
  applyClosedFileEdits,
  applyWorkspaceEdit,
  editsStayInside,
  openModelEdits,
  textEditsByUri,
} from './workspaceEdit'

export const APPLY_CODE_ACTION_COMMAND = 'pine.lsp.applyCodeAction'
const CODE_ACTION_INVOKED = 1
const CODE_ACTION_AUTOMATIC = 2
let applyCommand: monaco.IDisposable | null = null

export async function applyCodeAction(
  session: LspSession,
  action: CodeAction | Command,
): Promise<void> {
  let chosen = action
  const provider = session.capabilities.codeActionProvider
  const resolves = typeof provider === 'object' && provider.resolveProvider === true
  if ('title' in chosen && !('edit' in chosen) && typeof chosen.command !== 'string' && resolves) {
    chosen = (await session.request<CodeAction>('codeAction/resolve', chosen)) ?? chosen
  }
  if (typeof chosen.command === 'string') {
    const command = chosen as Command
    await session.request('workspace/executeCommand', {
      command: command.command,
      arguments: command.arguments,
    })
    return
  }
  const codeAction = chosen as CodeAction
  if (codeAction.edit) await applyWorkspaceEdit(codeAction.edit, session.info.editRoot)
  if (codeAction.command) {
    await session.request('workspace/executeCommand', {
      command: codeAction.command.command,
      arguments: codeAction.command.arguments,
    })
  }
}

function ensureApplyCommand(): void {
  if (applyCommand) return
  applyCommand = monaco.editor.registerCommand(
    APPLY_CODE_ACTION_COMMAND,
    (_accessor, session: LspSession, action: CodeAction | Command) => {
      void applyCodeAction(session, action)
    },
  )
}

export type SessionLookup = (model: monaco.editor.ITextModel) => LspSession | undefined

interface SessionCompletion extends LspCompletion {
  session: LspSession
}

const COMPLETION_INVOKED = 1
const COMPLETION_TRIGGER_CHARACTER = 2

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

  if (capabilities.documentRangeFormattingProvider) {
    registrations.push(
      languages.registerDocumentRangeFormattingEditProvider(language, {
        async provideDocumentRangeFormattingEdits(model, range, options, token) {
          const session = sessionOf(model)
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
      }),
    )
  }

  if (capabilities.referencesProvider) {
    registrations.push(
      languages.registerReferenceProvider(language, {
        async provideReferences(model, position, context, token) {
          const session = sessionOf(model)
          if (!session) return null
          return toLocations(
            await session.request<Location[]>(
              'textDocument/references',
              {
                ...documentPosition(model, position),
                context: { includeDeclaration: context.includeDeclaration },
              },
              token,
            ),
          )
        },
      }),
    )
  }

  if (capabilities.renameProvider) {
    const prepares =
      typeof capabilities.renameProvider === 'object' &&
      capabilities.renameProvider.prepareProvider === true
    registrations.push(
      languages.registerRenameProvider(language, {
        async provideRenameEdits(model, position, newName, token) {
          const session = sessionOf(model)
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
                const session = sessionOf(model)
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
                  text:
                    'placeholder' in prepared ? prepared.placeholder : model.getValueInRange(range),
                }
              },
            }
          : {}),
      }),
    )
  }

  if (capabilities.signatureHelpProvider) {
    const options = capabilities.signatureHelpProvider
    registrations.push(
      languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: options.triggerCharacters ?? [],
        signatureHelpRetriggerCharacters: options.retriggerCharacters ?? [],
        async provideSignatureHelp(model, position, token, context) {
          const session = sessionOf(model)
          if (!session) return null
          const value = toSignatureHelp(
            await session.request<SignatureHelp>(
              'textDocument/signatureHelp',
              {
                ...documentPosition(model, position),
                context: {
                  triggerKind: context.triggerKind,
                  isRetrigger: context.isRetrigger,
                  ...(context.triggerCharacter !== undefined
                    ? { triggerCharacter: context.triggerCharacter }
                    : {}),
                },
              },
              token,
            ),
          )
          return value ? { value, dispose: () => {} } : null
        },
      }),
    )
  }

  if (capabilities.documentSymbolProvider) {
    registrations.push(
      languages.registerDocumentSymbolProvider(language, {
        async provideDocumentSymbols(model, token) {
          const session = sessionOf(model)
          if (!session) return null
          return toDocumentSymbols(
            await session.request<(DocumentSymbol | SymbolInformation)[]>(
              'textDocument/documentSymbol',
              { textDocument: { uri: model.uri.toString() } },
              token,
            ),
          )
        },
      }),
    )
  }

  if (capabilities.documentHighlightProvider) {
    registrations.push(
      languages.registerDocumentHighlightProvider(language, {
        async provideDocumentHighlights(model, position, token) {
          const session = sessionOf(model)
          if (!session) return null
          return toHighlights(
            await session.request<DocumentHighlight[]>(
              'textDocument/documentHighlight',
              documentPosition(model, position),
              token,
            ),
          )
        },
      }),
    )
  }

  if (capabilities.codeActionProvider) {
    ensureApplyCommand()
    registrations.push(
      languages.registerCodeActionProvider(language, {
        async provideCodeActions(model, range, context, token) {
          const session = sessionOf(model)
          if (!session) return null
          const lspRange = toLspRange(range)
          const result = await session.request<(CodeAction | Command)[]>(
            'textDocument/codeAction',
            {
              textDocument: { uri: model.uri.toString() },
              range: lspRange,
              context: {
                diagnostics: session
                  .diagnosticsFor(model.uri.toString())
                  .filter((diagnostic) => rangesOverlap(diagnostic.range, lspRange)),
                triggerKind:
                  context.trigger === languages.CodeActionTriggerType.Invoke
                    ? CODE_ACTION_INVOKED
                    : CODE_ACTION_AUTOMATIC,
                ...(context.only ? { only: [context.only] } : {}),
              },
            },
            token,
          )
          const actions = (result ?? []).map((action): monaco.languages.CodeAction => {
            const literal = typeof action.command === 'string' ? null : (action as CodeAction)
            return {
              title: action.title,
              command: {
                id: APPLY_CODE_ACTION_COMMAND,
                title: action.title,
                arguments: [session, action],
              },
              ...(literal?.kind ? { kind: literal.kind } : {}),
              ...(literal?.isPreferred ? { isPreferred: true } : {}),
              ...(literal?.disabled ? { disabled: literal.disabled.reason } : {}),
              ...(literal?.diagnostics ? { diagnostics: toMarkers(literal.diagnostics) } : {}),
            }
          })
          return { actions, dispose: () => {} }
        },
      }),
    )
  }

  if (capabilities.inlayHintProvider) {
    registrations.push(
      languages.registerInlayHintsProvider(language, {
        async provideInlayHints(model, range, token) {
          const session = sessionOf(model)
          if (!session) return null
          const hints = toInlayHints(
            await session.request<InlayHint[]>(
              'textDocument/inlayHint',
              { textDocument: { uri: model.uri.toString() }, range: toLspRange(range) },
              token,
            ),
          )
          return { hints, dispose: () => {} }
        },
      }),
    )
  }

  const semantic = capabilities.semanticTokensProvider
  if (semantic?.legend && semantic.full) {
    const { legend } = semantic
    registrations.push(
      languages.registerDocumentSemanticTokensProvider(language, {
        getLegend: () => ({
          tokenTypes: [...legend.tokenTypes],
          tokenModifiers: [...legend.tokenModifiers],
        }),
        async provideDocumentSemanticTokens(model, _lastResultId, token) {
          const session = sessionOf(model)
          if (!session) return null
          const tokens = await session.request<SemanticTokens>(
            'textDocument/semanticTokens/full',
            { textDocument: { uri: model.uri.toString() } },
            token,
          )
          return tokens ? { data: new Uint32Array(tokens.data) } : null
        },
        releaseDocumentSemanticTokens: () => {},
      }),
    )
  }

  return {
    dispose: () => {
      for (const registration of registrations) registration.dispose()
    },
  }
}
