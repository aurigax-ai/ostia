import { connect, onShutdown } from '@aurigax-ai/ostia-extension-sdk'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { createAgentHost } from './agentHost'

async function main(): Promise<void> {
  const dataDir = readEnv('EXTENSION_DATA')
  if (!dataDir) throw new Error('OSTIA_EXTENSION_DATA missing')
  const ext = await connect()
  const host = createAgentHost({
    dataDir,
    callTool: (call, signal) => ext.agentTool(call, signal),
    emit: (sessionId, event) => {
      void ext.agentEvent(sessionId, event).catch(() => undefined)
    },
  })
  ext.onAgent((request) => host.handle(request))
  await ext.registerCommands({})
  onShutdown(host.closeAll)
}

void main()
