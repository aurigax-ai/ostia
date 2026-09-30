import { type ComposerMode, composerModeFor } from '../lib/assistComposer'
import { canTypeInto } from '../lib/blockActions'
import { runningAgent } from '../lib/sendPick'
import { terminalFor } from '../lib/terminalHandles'
import { useAssistComposerStore } from '../stores/assistComposerStore'
import { assistProvider, useAssistStore } from '../stores/assistStore'
import { useBlocksStore } from '../stores/blocksStore'
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
  commands.register<undefined, { opened: boolean }>({
    id: ASSIST_COMPOSE_COMMAND,
    title: 'Compose with Assistant',
    category: 'Assistant',
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
