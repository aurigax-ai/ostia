import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { REGISTRY_HOSTS, parsePackageDownload } from '../../shared/packages'
import { PRODUCT_DISPLAY_NAME } from '../../shared/productDisplay'
import { type ListeningChannel, type Respond, listenHostChannel } from './hostChannel'
import { cachedLookups } from './packageLookups'
import { type PackagePolicy, decidePackage } from './packagePolicy'
import type { HostToMain, MainToHost } from './protocol'

const lookups = cachedLookups()
let packagePolicy: PackagePolicy | null = null

function isRegistry(domain: string): boolean {
  return (REGISTRY_HOSTS as readonly string[]).includes(domain.split(':')[0])
}

function withFirewall(config: SandboxRuntimeConfig): SandboxRuntimeConfig {
  const policy = packagePolicy
  if (!policy) return config
  return {
    ...config,
    network: {
      ...config.network,
      tlsTerminate: {
        excludeDomains: config.network.allowedDomains.filter((d) => !isRegistry(d)),
      },
      filterRequest: async (request: Request) => {
        const ref = parsePackageDownload(request.url)
        if (!ref) return { action: 'allow' as const }
        const decision = await decidePackage(ref, policy, lookups, Date.now())
        if (decision.allow) return { action: 'allow' as const }
        send({ type: 'package-blocked', pkg: ref, reason: decision.reason })
        return {
          action: 'deny' as const,
          reason: `${PRODUCT_DISPLAY_NAME}'s sandbox blocked ${ref.name}@${ref.version} (${decision.reason}). The human was asked; retry after they allow it.`,
        }
      },
    },
  }
}

const VIOLATION_FLUSH_MS = 200
const VIOLATIONS_PER_FLUSH = 50

let reported = 0
let queued: string[] = []
let flushTimer: NodeJS.Timeout | null = null

function flushViolations(): void {
  flushTimer = null
  const lines = queued.slice(-VIOLATIONS_PER_FLUSH)
  queued = []
  if (lines.length > 0) send({ type: 'violations', lines })
}

function reportViolations(): void {
  const store = SandboxManager.getSandboxViolationStore()
  store.subscribe((violations) => {
    const total = store.getTotalCount()
    const fresh = Math.min(total - reported, violations.length)
    reported = total
    if (fresh <= 0) return
    queued.push(...violations.slice(-fresh).map((v) => v.line))
    flushTimer ??= setTimeout(flushViolations, VIOLATION_FLUSH_MS)
  })
}

const pendingAsks = new Map<number, (allow: boolean) => void>()
let askSeq = 0

let channel: ListeningChannel | null = null

function send(message: HostToMain): void {
  if (channel) channel.send(message)
  else process.send?.(message)
}

function shutdown(): void {
  channel?.close()
  void SandboxManager.reset().finally(() => process.exit(0))
}

function ask(host: string, port: number | undefined): Promise<boolean> {
  const askId = ++askSeq
  return new Promise((resolve) => {
    pendingAsks.set(askId, resolve)
    send({ type: 'ask', askId, host, ...(port === undefined ? {} : { port }) })
  })
}

async function handle(message: MainToHost, respond: Respond): Promise<void> {
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
        respond({ id, ok: false, error: deps.errors.join('; '), missing: deps.errors })
        return
      }
      packagePolicy = message.packages ?? null
      await SandboxManager.initialize(
        withFirewall(message.config),
        ({ host, port }) => ask(host, port),
        true,
      )
      reportViolations()
      respond({ id, ok: true })
    } else if (message.type === 'wrap') {
      const wrapped = await SandboxManager.wrapWithSandbox(
        message.command,
        message.binShell,
        message.customConfig,
      )
      respond({ id, ok: true, wrapped })
    } else if (message.type === 'update') {
      packagePolicy = message.packages ?? null
      SandboxManager.updateConfig(withFirewall(message.config))
      respond({ id, ok: true })
    } else if (message.type === 'shutdown') {
      respond({ id, ok: true })
      shutdown()
    } else {
      SandboxManager.cleanupAfterCommand()
      respond({ id, ok: true })
    }
  } catch (err) {
    respond({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

const LISTEN_FLAG = '--listen'
const listenIndex = process.argv.indexOf(LISTEN_FLAG)
const listenPath = listenIndex === -1 ? undefined : process.argv[listenIndex + 1]

if (listenPath) {
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) process.on(signal, shutdown)
  channel = await listenHostChannel(listenPath, (message, respond) => {
    void handle(message, respond)
  })
} else {
  process.on('message', (message: MainToHost) => {
    void handle(message, (response) => process.send?.(response))
  })
  process.on('disconnect', shutdown)
}
