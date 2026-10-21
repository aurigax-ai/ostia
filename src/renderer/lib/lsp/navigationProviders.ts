import type {
  DocumentHighlight,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InlayHint,
  Location,
  LocationLink,
  SignatureHelp,
  SignatureHelpOptions,
  SymbolInformation,
} from 'vscode-languageserver-protocol'
import { monaco } from '@/lib/monaco/setup'
import {
  toDocumentSymbols,
  toFoldingRanges,
  toHighlights,
  toHover,
  toInlayHints,
  toLocations,
  toLspRange,
  toSignatureHelp,
} from './converters'
import { documentPosition, type ProviderParams } from './providerParams'

interface SignatureHelpParams extends ProviderParams {
  options: SignatureHelpOptions
}

export function registerHover({ language, sessionOf }: ProviderParams): monaco.IDisposable {
  return monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position, token) {
      const session = sessionOf(model, 'textDocument/hover')
      if (!session) return null
      return toHover(
        await session.request<Hover>(
          'textDocument/hover',
          documentPosition(model, position),
          token,
        ),
      )
    },
  })
}

export function registerDefinition({ language, sessionOf }: ProviderParams): monaco.IDisposable {
  return monaco.languages.registerDefinitionProvider(language, {
    async provideDefinition(model, position, token) {
      const session = sessionOf(model, 'textDocument/definition')
      if (!session) return null
      return toLocations(
        await session.request<Location | Location[] | LocationLink[]>(
          'textDocument/definition',
          documentPosition(model, position),
          token,
        ),
      )
    },
  })
}

export function registerReferences({ language, sessionOf }: ProviderParams): monaco.IDisposable {
  return monaco.languages.registerReferenceProvider(language, {
    async provideReferences(model, position, context, token) {
      const session = sessionOf(model, 'textDocument/references')
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
  })
}

export function registerSignatureHelp({
  language,
  sessionOf,
  options,
}: SignatureHelpParams): monaco.IDisposable {
  return monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: options.triggerCharacters ?? [],
    signatureHelpRetriggerCharacters: options.retriggerCharacters ?? [],
    async provideSignatureHelp(model, position, token, context) {
      const session = sessionOf(model, 'textDocument/signatureHelp')
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
  })
}

export function registerDocumentSymbols({
  language,
  sessionOf,
}: ProviderParams): monaco.IDisposable {
  return monaco.languages.registerDocumentSymbolProvider(language, {
    async provideDocumentSymbols(model, token) {
      const session = sessionOf(model, 'textDocument/documentSymbol')
      if (!session) return null
      return toDocumentSymbols(
        await session.request<(DocumentSymbol | SymbolInformation)[]>(
          'textDocument/documentSymbol',
          { textDocument: { uri: model.uri.toString() } },
          token,
        ),
      )
    },
  })
}

export function registerDocumentHighlights({
  language,
  sessionOf,
}: ProviderParams): monaco.IDisposable {
  return monaco.languages.registerDocumentHighlightProvider(language, {
    async provideDocumentHighlights(model, position, token) {
      const session = sessionOf(model, 'textDocument/documentHighlight')
      if (!session) return null
      return toHighlights(
        await session.request<DocumentHighlight[]>(
          'textDocument/documentHighlight',
          documentPosition(model, position),
          token,
        ),
      )
    },
  })
}

export function registerInlayHints({ language, sessionOf }: ProviderParams): monaco.IDisposable {
  return monaco.languages.registerInlayHintsProvider(language, {
    async provideInlayHints(model, range, token) {
      const session = sessionOf(model, 'textDocument/inlayHint')
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
  })
}

export function registerFoldingRanges({ language, sessionOf }: ProviderParams): monaco.IDisposable {
  return monaco.languages.registerFoldingRangeProvider(language, {
    async provideFoldingRanges(model, _context, token) {
      const session = sessionOf(model, 'textDocument/foldingRange')
      if (!session) return null
      const ranges = await session.request<FoldingRange[]>(
        'textDocument/foldingRange',
        { textDocument: { uri: model.uri.toString() } },
        token,
      )
      return ranges ? toFoldingRanges(ranges) : null
    },
  })
}
