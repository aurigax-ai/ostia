import { AGENT_EXTENSION_ID } from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { parseAgentSettings } from '../../shared/agent/agentSettings'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import type { ExtensionHost } from '../extensions/extensionHost'
import { readSettingsFile } from '../platform/settingsFile'
import type { RedactText } from '../privacy/redactionTargets'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { registerAgentIpc } from './agentIpc'
import { AgentSessions, NO_AGENT } from './agentSessions'

interface AgentStartDeps {
  services: { extensionHost: ExtensionHost | null; agentSessions: AgentSessions | null }
  redactor: { text: RedactText }
  workspaceSandboxes: Pick<WorkspaceSandboxes, 'isEnabled'>
}

export function startAgent({ services, redactor, workspaceSandboxes }: AgentStartDeps): void {
  const fromAgent = (ctx: ControlMethodContext): boolean =>
    services.extensionHost?.builtinId(ctx.identity, ctx.conn) === AGENT_EXTENSION_ID
  services.agentSessions = new AgentSessions({
    request: (request) =>
      services.extensionHost?.agentRequest(request) ?? Promise.resolve(NO_AGENT),
    settings: () => parseAgentSettings(readSettingsFile().agent),
    sandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    redact: (text) => redactor.text(text),
  })
  registerAgentIpc(() => services.agentSessions)
  registerControlMethod('ext.agentEvent', {
    callers: 'extensions',
    handler: (params, ctx) =>
      services.agentSessions?.event(fromAgent(ctx), params) ?? { ok: false },
  })
  registerControlMethod('ext.agentTool', {
    callers: 'extensions',
    handler: (params, ctx) =>
      services.agentSessions?.tool(fromAgent(ctx), params, (listener) =>
        ctx.token?.onCancellationRequested(listener),
      ) ?? { ok: false, error: 'unavailable' },
  })
}
