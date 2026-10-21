import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { ServerProvider } from '../../shared/server/serverApi'
import { parseServerUrl } from './serverUrl'

export interface ServerIdentity {
  accountId: string
  deviceId: string
  provider: ServerProvider
  deviceName: string
}

export interface ServerConfigDeps {
  load: () => unknown
  save: (data: StoredServer) => void
  defaultUrl: () => string | null
  allowInsecure: boolean
}

interface StoredServer {
  url: string | null
  identity: ServerIdentity | null
}

function parseIdentity(value: unknown): ServerIdentity | null {
  if (!isRecord(value)) return null
  const { accountId, deviceId, provider, deviceName } = value
  if (typeof accountId !== 'string' || typeof deviceId !== 'string') return null
  if (typeof deviceName !== 'string') return null
  if (provider !== 'invite' && provider !== 'github') return null
  return { accountId, deviceId, provider, deviceName }
}

export class ServerConfig {
  constructor(private readonly deps: ServerConfigDeps) {}

  private read(): StoredServer {
    const stored = this.deps.load()
    if (!isRecord(stored)) return { url: null, identity: null }
    const url =
      typeof stored.url === 'string' ? parseServerUrl(stored.url, this.deps.allowInsecure) : null
    return { url, identity: parseIdentity(stored.identity) }
  }

  url(): string | null {
    return this.read().url ?? this.deps.defaultUrl()
  }

  setUrl(url: string | null): void {
    this.deps.save({ ...this.read(), url })
  }

  identity(): ServerIdentity | null {
    return this.read().identity
  }

  setIdentity(identity: ServerIdentity | null): void {
    this.deps.save({ ...this.read(), identity })
  }
}
