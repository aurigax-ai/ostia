import { runningAgent } from '@/lib/agents/paneAgent'
import { type ComposerMode, composerModeFor } from '@/lib/assist/assistComposer'
import { canTypeInto } from '@/lib/terminal/blockActions'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { useAssistComposerStore } from '../stores/assistComposerStore'
import { assistProvider, useAssistStore } from '../stores/assistStore'
import { useBlocksStore } from '../stores/blocksStore'
import { registerCore } from './core'
import { commands } from './registry'

export const ASSIST_COMPOSE_COMMAND = 'assist.compose'

export function composerModeOf(paneId: string): ComposerMode | null {
  if (!terminalFor(paneId)) return null
  return composerModeFor({
    agent: runningAgent(paneId) !== null,
    idlePrompt: canTypeInto(paneId),
    inputReady: assistProvider('input') !== null,
    commandReady: assistProvider('command') !== null,
  })
}

export function composerAgentName(paneId: string): string {
  const agent = runningAgent(paneId)
  if (agent && agent !== 'other') return agent
  const { running, byPane } = useBlocksStore.getState()
  const command = byPane[paneId]?.find((b) => b.id === running[paneId])?.command ?? ''
  return command.trim().split(/\s+/)[0]?.split('/').pop() || 'agent'
}

function composeAvailable(): boolean {
  const { availability } = useAssistStore.getState()
  return Boolean(availability.input || availability.command)
}

function register(): void {
  if (commands.has(ASSIST_COMPOSE_COMMAND)) return
  registerCore<undefined, { opened: boolean }>({
    id: ASSIST_COMPOSE_COMMAND,
    category: 'assistant',
    target: 'active',
    run: (_args, ctx) => {
      const paneId = ctx.activePaneId
      if (!paneId || !composerModeOf(paneId)) return { opened: false }
      useAssistComposerStore.getState().open(paneId)
      return { opened: true }
    },
  })
}

export function startAssistCompose(): () => void {
  const sync = (): void => {
    if (composeAvailable()) register()
    else if (commands.has(ASSIST_COMPOSE_COMMAND)) {
      commands.unregister(ASSIST_COMPOSE_COMMAND)
      useAssistComposerStore.getState().close()
    }
  }
  sync()
  return useAssistStore.subscribe(sync)
}
