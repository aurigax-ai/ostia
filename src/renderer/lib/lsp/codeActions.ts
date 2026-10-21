import type { CodeAction, Command } from 'vscode-languageserver-protocol'
import { monaco } from '@/lib/monaco/setup'
import { rangesOverlap, toLspRange, toMarkers } from './converters'
import type { ProviderParams } from './providerParams'
import type { LspSession } from './session'
import { applyWorkspaceEdit } from './workspaceEdit'

export const APPLY_CODE_ACTION_COMMAND = 'ostia.lsp.applyCodeAction'
const CODE_ACTION_INVOKED = 1
const CODE_ACTION_AUTOMATIC = 2
let applyCommand: monaco.IDisposable | null = null

async function applyCodeAction(session: LspSession, action: CodeAction | Command): Promise<void> {
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

export function ensureApplyCommand(): void {
  if (applyCommand) return
  applyCommand = monaco.editor.registerCommand(
    APPLY_CODE_ACTION_COMMAND,
    (_accessor, session: LspSession, action: CodeAction | Command) => {
      void applyCodeAction(session, action)
    },
  )
}

export function registerCodeActions({ language, sessionOf }: ProviderParams): monaco.IDisposable {
  const { languages } = monaco
  return languages.registerCodeActionProvider(language, {
    async provideCodeActions(model, range, context, token) {
      const session = sessionOf(model, 'textDocument/codeAction')
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
  })
}
