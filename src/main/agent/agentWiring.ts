import { parseAgentSettings } from '../../shared/agent/agentSettings'
import { registerControlMethod } from '../control/controlServer'
import type { ExtensionHost } from '../extensions/extensionHost'
import { readSettingsFile } from '../platform/settingsFile'
import type { RedactText } from '../privacy/redactionTargets'
import { registerAgentIpc } from './agentIpc'
import { AgentSessions, NO_AGENT } from './agentSessions'

interface AgentStartDeps {
  services: { extensionHost: ExtensionHost | null; agentSessions: AgentSessions | null }
  redactor: { text: RedactText }
}

export function startAgent({ services, redactor }: AgentStartDeps): void {
  services.agentSessions = new AgentSessions({
    request: (request) =>
      services.extensionHost?.agentRequest(request) ?? Promise.resolve(NO_AGENT),
    settings: () => parseAgentSettings(readSettingsFile().agent),
    redact: (text) => redactor.text(text),
  })
  registerAgentIpc(() => services.agentSessions)
  registerControlMethod('ext.agentEvent', {
    callers: 'extensions',
    handler: (params, ctx) =>
      services.agentSessions?.event(ctx.identity.extId, params) ?? { ok: false },
  })
  registerControlMethod('ext.agentTool', {
    callers: 'extensions',
    handler: (params, ctx) =>
      services.agentSessions?.tool(ctx.identity.extId, params, (listener) =>
        ctx.token?.onCancellationRequested(listener),
      ) ?? { ok: false, error: 'unavailable' },
  })
}
