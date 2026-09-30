import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { HostToMain, MainToHost } from './protocol'

const pendingAsks = new Map<number, (allow: boolean) => void>()
let askSeq = 0

function send(message: HostToMain): void {
  process.send?.(message)
}

function ask(host: string, port: number | undefined): Promise<boolean> {
  const askId = ++askSeq
  return new Promise((resolve) => {
    pendingAsks.set(askId, resolve)
    send({ type: 'ask', askId, host, ...(port === undefined ? {} : { port }) })
  })
}

async function handle(message: MainToHost): Promise<void> {
  if (message.type === 'ask-answer') {
    pendingAsks.get(message.askId)?.(message.allow)
    pendingAsks.delete(message.askId)
    return
  }
  const { id } = message
  try {
    if (message.type === 'init') {
      const deps = await SandboxManager.checkDependenciesAsync()
      if (deps.errors.length > 0) {
        send({ id, ok: false, error: deps.errors.join('; '), missing: deps.errors })
        return
      }
      await SandboxManager.initialize(message.config, ({ host, port }) => ask(host, port))
      send({ id, ok: true })
    } else if (message.type === 'wrap') {
      const wrapped = await SandboxManager.wrapWithSandbox(
        message.command,
        message.binShell,
        message.customConfig,
      )
      send({ id, ok: true, wrapped })
    } else if (message.type === 'update') {
      SandboxManager.updateConfig(message.config)
      send({ id, ok: true })
    } else {
      SandboxManager.cleanupAfterCommand()
      send({ id, ok: true })
    }
  } catch (err) {
    send({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

process.on('message', (message: MainToHost) => {
  void handle(message)
})

process.on('disconnect', () => {
  void SandboxManager.reset().finally(() => process.exit(0))
})
