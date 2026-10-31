import type { AgentSessions } from '../agent/agentSessions'
import { registerCredentials } from '../browser/credentials'
import { registerExtensionMcp } from '../chat/extensionMcp'
import type { McpHost } from '../chat/mcpHost'
import type { Telemetry } from '../diagnostics/telemetry'
import type { ExtensionHost } from '../extensions/extensionHost'
import { phoneCanRespond } from '../gateway/server'
import type { AppWindows } from '../windows/appWindows'
import type { WindowSend } from '../windows/windowSend'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import { registerApprovals } from './approvals'
import type { AskHub } from './asks'
import { registerPermissionAsk } from './permissionAsk'
import { questions, registerExtensionQuestions, registerQuestions } from './questions'

interface ApprovalsWiringDeps {
  revealWindow: AppWindows['revealWindow']
  settingsChanged: WindowSend['settingsChanged']
  services: {
    agentSessions: AgentSessions | null
    extensionHost: ExtensionHost | null
    mcpHost: McpHost | null
    telemetry: Telemetry | null
  }
  askHub: AskHub
}

export function registerApprovalsWiring({
  revealWindow,
  settingsChanged,
  services,
  askHub,
}: ApprovalsWiringDeps) {
  const approvalCaps = new Map<string, readonly string[]>()
  registerApprovals(revealWindow, settingsChanged, {
    opened: (request) => {
      approvalCaps.set(request.id, request.caps)
      for (const cap of request.caps) services.telemetry?.count('agents', 'approval_shown', cap)
      askHub.approvalOpened(request)
      services.agentSessions?.approvalOpened(request.paneId, request.id)
    },
    settled: (id, outcome) => {
      const caps = approvalCaps.get(id) ?? []
      approvalCaps.delete(id)
      if (outcome !== 'timeout' && outcome !== 'auto') {
        for (const cap of caps) services.telemetry?.count('agents', 'approval_answered', cap)
      }
      askHub.settled(id, outcome)
      services.agentSessions?.approvalSettled(id)
    },
  })
  registerQuestions({
    opened: (request) => {
      services.telemetry?.count('agents', 'question_asked')
      askHub.questionOpened(request)
    },
    settled: (id, outcome) => {
      if (outcome === 'answered') services.telemetry?.count('agents', 'question_answered')
      askHub.settled(id, outcome)
    },
  })
  registerExtensionMcp({ mcp: () => services.mcpHost })
  registerExtensionQuestions({
    windowOfWorkspace: windowForWorkspace,
    extensionName: (extId) => services.extensionHost?.displayName(extId) ?? extId,
  })
  registerPermissionAsk({ questions, phoneCanAnswer: phoneCanRespond })
  registerCredentials()
}
