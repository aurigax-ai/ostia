import {
  type CommandHandler,
  type EventHandler,
  type OstiaExtension,
  cliArgs,
  ok,
  parseAgentStop,
} from '@aurigax-ai/ostia-extension-sdk'
import {
  isAgentHookEvent,
  isHookAgent,
} from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import type { GraphsRunner } from './runner'
import type { TriggerHost } from './triggers'

interface PaneSignalsDeps {
  ext: OstiaExtension
  runner: GraphsRunner
  triggers: TriggerHost
  refresh: () => Promise<void>
}

export function createPaneSignals(deps: PaneSignalsDeps): {
  onStop: CommandHandler
  onEvent: EventHandler
} {
  const { ext, runner, triggers, refresh } = deps
  const agentWaiting = async (pane: string, workspaceId: string): Promise<void> => {
    const info = (await ext.listPanes().catch(() => [])).find((p) => p.paneId === pane)
    triggers.agent(workspaceId, pane, 'waiting', info?.agent)
  }

  const onStop: CommandHandler = async (args, caller) => {
    const parsed = cliArgs(args)
    const [agent, event] = parsed?.argv ?? []
    if (!parsed?.stdin || caller.kind !== 'pane' || !caller.paneId) return ok()
    if (caller.agentRunning !== true) return ok()
    if (!isHookAgent(agent) || !isAgentHookEvent(event) || event !== 'Stop') return ok()
    const stop = parseAgentStop(agent, parsed.stdin)
    if (!stop) return ok()
    await runner.stopped({
      pane: caller.paneId,
      session: stop.sessionId,
      backgroundWork: stop.backgroundWork,
      ...(stop.message !== undefined ? { message: stop.message } : {}),
    })
    if (caller.workspaceId) triggers.agent(caller.workspaceId, caller.paneId, 'stopped', agent)
    return ok()
  }

  const onEvent: EventHandler = (type, payload) => {
    const event = payload as {
      paneId?: string
      workspaceId?: string
      exitCode?: number
      state?: string
      remote?: boolean
    }
    const pane = event.paneId
    if (type === 'pane.attention') {
      if (pane && event.workspaceId && event.state === 'waiting')
        void agentWaiting(pane, event.workspaceId)
      return
    }
    if (type === 'pane.closed' && pane) void runner.stopped({ pane, closed: true })
    else if (type === 'command.finished' && pane) {
      void runner.stopped({ pane, exited: true })
      if (event.workspaceId)
        triggers.commandFinished({ ...event, paneId: pane, workspaceId: event.workspaceId })
    }
    void refresh()
  }

  return { onStop, onEvent }
}
