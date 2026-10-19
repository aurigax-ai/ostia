import { openAgentPane } from '@/lib/agent/agentPane'
import { registerCore } from './coreCommand'

export function registerAgentCommand(): void {
  registerCore({
    id: 'agent.open',
    category: 'agent',
    target: 'none',
    run: () => {
      openAgentPane()
    },
  })
}
