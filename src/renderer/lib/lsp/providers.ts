import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import type { monaco } from '@/lib/monaco/setup'
import { ensureApplyCommand, registerCodeActions } from './codeActions'
import { registerCodeLens } from './codeLens'
import { registerCompletion } from './completionProvider'
import { registerDocumentFormatting, registerRangeFormatting } from './formattingProviders'
import {
  registerDefinition,
  registerDocumentHighlights,
  registerDocumentSymbols,
  registerFoldingRanges,
  registerHover,
  registerInlayHints,
  registerReferences,
  registerSignatureHelp,
} from './navigationProviders'
import type { ProviderParams, SessionLookup } from './providerParams'
import { registerRename } from './renameProvider'
import { registerSemanticTokens } from './semanticTokens'

export function registerProviders(
  language: string,
  capabilities: ServerCapabilities,
  sessionOf: SessionLookup,
): monaco.IDisposable {
  const registrations: monaco.IDisposable[] = []
  const params: ProviderParams = { language, sessionOf }

  if (capabilities.completionProvider) {
    registrations.push(registerCompletion({ ...params, options: capabilities.completionProvider }))
  }
  if (capabilities.hoverProvider) registrations.push(registerHover(params))
  if (capabilities.definitionProvider) registrations.push(registerDefinition(params))
  if (capabilities.documentFormattingProvider) {
    registrations.push(registerDocumentFormatting(params))
  }
  if (capabilities.documentRangeFormattingProvider) {
    registrations.push(registerRangeFormatting(params))
  }
  if (capabilities.referencesProvider) registrations.push(registerReferences(params))
  if (capabilities.renameProvider) {
    registrations.push(registerRename({ ...params, options: capabilities.renameProvider }))
  }
  if (capabilities.signatureHelpProvider) {
    registrations.push(
      registerSignatureHelp({ ...params, options: capabilities.signatureHelpProvider }),
    )
  }
  if (capabilities.documentSymbolProvider) registrations.push(registerDocumentSymbols(params))
  if (capabilities.documentHighlightProvider) {
    registrations.push(registerDocumentHighlights(params))
  }
  if (capabilities.codeActionProvider) {
    ensureApplyCommand()
    registrations.push(registerCodeActions(params))
  }
  if (capabilities.inlayHintProvider) registrations.push(registerInlayHints(params))
  if (capabilities.foldingRangeProvider) registrations.push(registerFoldingRanges(params))
  if (capabilities.codeLensProvider) {
    ensureApplyCommand()
    registrations.push(registerCodeLens({ ...params, options: capabilities.codeLensProvider }))
  }
  const semantic = capabilities.semanticTokensProvider
  if (semantic?.legend && semantic.full) {
    registrations.push(registerSemanticTokens({ ...params, options: semantic }))
  }

  return {
    dispose: () => {
      for (const registration of registrations) registration.dispose()
    },
  }
}
