import type { CodeLens, CodeLensOptions } from 'vscode-languageserver-protocol'
import { monaco } from '@/lib/monaco/setup'
import { APPLY_CODE_ACTION_COMMAND } from './codeActions'
import { toMonacoRange } from './converters'
import type { ProviderParams, SessionLookup } from './providerParams'
import type { LspSession } from './session'

interface SessionCodeLens extends monaco.languages.CodeLens {
  lspLens: CodeLens
  session: LspSession
}

interface CodeLensParams extends ProviderParams {
  options: CodeLensOptions
}

let codeLensChanges: monaco.Emitter<monaco.languages.CodeLensProvider> | null = null

function codeLensEmitter(): monaco.Emitter<monaco.languages.CodeLensProvider> {
  codeLensChanges ??= new monaco.Emitter<monaco.languages.CodeLensProvider>()
  return codeLensChanges
}

const codeLensProviders = new Set<monaco.languages.CodeLensProvider>()

export function refreshCodeLenses(): void {
  for (const provider of codeLensProviders) codeLensEmitter().fire(provider)
}

function toCodeLens(session: LspSession, lens: CodeLens): SessionCodeLens {
  const { command } = lens
  return {
    range: toMonacoRange(lens.range),
    ...(command
      ? {
          command: session.runsCommand(command.command)
            ? { id: APPLY_CODE_ACTION_COMMAND, title: command.title, arguments: [session, command] }
            : { id: '', title: command.title },
        }
      : {}),
    lspLens: lens,
    session,
  }
}

function codeLensProvider(
  options: CodeLensOptions,
  sessionOf: SessionLookup,
): monaco.languages.CodeLensProvider {
  const resolves = options.resolveProvider === true
  return {
    onDidChange: codeLensEmitter().event,
    async provideCodeLenses(model, token) {
      const session = sessionOf(model, 'textDocument/codeLens')
      if (!session) return { lenses: [], dispose: () => {} }
      const lenses = await session.request<CodeLens[]>(
        'textDocument/codeLens',
        { textDocument: { uri: model.uri.toString() } },
        token,
      )
      return {
        lenses: (lenses ?? []).map((lens) => toCodeLens(session, lens)),
        dispose: () => {},
      }
    },
    async resolveCodeLens(_model, codeLens, token) {
      const { lspLens, session } = codeLens as Partial<SessionCodeLens>
      if (!lspLens || !session || lspLens.command || !resolves) return codeLens
      const resolved = await session.request<CodeLens>('codeLens/resolve', lspLens, token)
      return resolved ? toCodeLens(session, resolved) : codeLens
    },
  }
}

export function registerCodeLens({
  language,
  sessionOf,
  options,
}: CodeLensParams): monaco.IDisposable {
  const provider = codeLensProvider(options, sessionOf)
  const registration = monaco.languages.registerCodeLensProvider(language, provider)
  codeLensProviders.add(provider)
  return {
    dispose: () => {
      codeLensProviders.delete(provider)
      registration.dispose()
    },
  }
}
