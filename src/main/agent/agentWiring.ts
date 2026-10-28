import { AGENT_EXTENSION_ID } from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { parseAgentSettings } from '../../shared/agent/agentSettings'
import {
  callControlMethod,
  type ExtensionMethodContext,
  registerControlMethod,
} from '../control/controlServer'
import { getByPaneId, resolveExternal } from '../control/idRegistry'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { ProcessRegistry } from '../panes/processRegistry'
import { readSettingsFile } from '../platform/settingsFile'
import type { RedactText } from '../privacy/redactionTargets'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { type AgentCoreDeps, createAgentCoreCall } from './agentCoreCall'
import { registerAgentIpc } from './agentIpc'
import { createPromptMail } from './agentMail'
import { AgentSessions, NO_AGENT } from './agentSessions'

const COMPLETE_EXTENSION_ID = 'skills'

interface AgentStartDeps {
  services: { extensionHost: ExtensionHost | null; agentSessions: AgentSessions | null }
  redactor: { text: RedactText }
  workspaceSandboxes: Pick<WorkspaceSandboxes, 'isEnabled'>
  registry: Pick<ProcessRegistry, 'isChild'>
}

export function startAgent({
  services,
  redactor,
  workspaceSandboxes,
  registry,
}: AgentStartDeps): void {
  const fromBuiltin = (ctx: ExtensionMethodContext, id: string): boolean =>
    services.extensionHost?.builtinId(ctx.identity, ctx.conn) === id
  const fromAgent = (ctx: ExtensionMethodContext): boolean => fromBuiltin(ctx, AGENT_EXTENSION_ID)
  const coreDeps: AgentCoreDeps = {
    identityOf: getByPaneId,
    sandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    ownsChild: (ownerPaneId, externalPaneId) => {
      const child = resolveExternal(externalPaneId)
      return child?.kind === 'pane' && registry.isChild(ownerPaneId, child.paneId)
    },
    call: callControlMethod,
  }
  services.agentSessions = new AgentSessions({
    request: (request) =>
      services.extensionHost?.agentRequest(request) ?? Promise.resolve(NO_AGENT),
    settings: () => parseAgentSettings(readSettingsFile().agent),
    sandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    redact: (text) => redactor.text(text),
    coreCall: createAgentCoreCall(coreDeps),
    promptMail: createPromptMail(coreDeps),
    rulesContext: (workspaceId, cwd, sessionId) =>
      services.extensionHost?.agentContext(workspaceId, cwd, sessionId) ??
      Promise.resolve({ text: '', count: 0 }),
  })
  registerAgentIpc(() => services.agentSessions)
  registerControlMethod('ext.agentEvent', {
    callers: 'extensions',
    handler: (params, ctx: ExtensionMethodContext) =>
      services.agentSessions?.event(fromAgent(ctx), params) ?? { ok: false },
  })
  registerControlMethod('ext.agentComplete', {
    callers: 'extensions',
    cap: 'agent-complete',
    handler: (params, ctx: ExtensionMethodContext) =>
      fromBuiltin(ctx, COMPLETE_EXTENSION_ID)
        ? (services.agentSessions?.complete(params) ?? { ok: false, error: 'unavailable' })
        : { ok: false, error: 'skills-only' },
  })
  registerControlMethod('ext.agentTool', {
    callers: 'extensions',
    handler: (params, ctx: ExtensionMethodContext) =>
      services.agentSessions?.tool(fromAgent(ctx), params, (listener) =>
        ctx.token?.onCancellationRequested(listener),
      ) ?? { ok: false, error: 'unavailable' },
  })
}
