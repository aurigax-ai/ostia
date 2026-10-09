import { homedir } from 'node:os'
import { type MCPClient, type OAuthClientProvider, createMCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import {
  CHAT_TOOL_DESCRIPTION_MAX,
  CHAT_TOOL_OUTPUT_MAX,
  CHAT_TOOL_SCHEMA_MAX,
} from '../../shared/assist'
import {
  MCP_TOOLS_PER_SERVER_MAX,
  type McpAuthState,
  type McpCallResult,
  type McpServerSettings,
  type McpServerState,
  type McpServerStatus,
  type McpTestResult,
  type McpToolInfo,
  mcpTransportOf,
} from '../../shared/assist/chatTools'
import { PRODUCT_DISPLAY_NAME } from '../../shared/productDisplay'

export const MCP_CONNECT_TIMEOUT_MS = 15_000
export const MCP_CALL_TIMEOUT_MS = 120_000
const ERROR_MAX = 240
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export interface McpAuthSource {
  provider: (server: McpServerSettings) => OAuthClientProvider | undefined
  state: (server: McpServerSettings, unauthorized: boolean) => McpAuthState | undefined
  prune: (servers: McpServerSettings[]) => void
}

export interface McpHostDeps {
  servers: () => McpServerSettings[]
  secret: (server: string, key: string) => string | null
  onStatus: (status: McpServerStatus[]) => void
  auth?: McpAuthSource
  connectTimeoutMs?: number
  callTimeoutMs?: number
}

interface Entry {
  fingerprint: string
  settings: McpServerSettings
  client: MCPClient | null
  state: McpServerState
  error?: string
  tools: McpToolInfo[]
  generation: number
  unauthorized: boolean
}

interface Connection {
  client: MCPClient
  tools: McpToolInfo[]
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/\s+/g, ' ').trim().slice(0, ERROR_MAX) || 'failed'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toolInfo(raw: unknown): McpToolInfo | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name || raw.name.length > 128) {
    return null
  }
  const schema = isRecord(raw.inputSchema) ? raw.inputSchema : { type: 'object' }
  if (schema.type !== 'object' || JSON.stringify(schema).length > CHAT_TOOL_SCHEMA_MAX) return null
  const description =
    typeof raw.description === 'string' && raw.description.trim()
      ? raw.description.trim().slice(0, CHAT_TOOL_DESCRIPTION_MAX)
      : raw.name
  return {
    name: raw.name,
    description,
    inputSchema: JSON.parse(JSON.stringify(schema)) as Record<string, unknown>,
  }
}

export function formatCallResult(raw: unknown): McpCallResult {
  const result = isRecord(raw) ? raw : {}
  const pieces: string[] = []
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (!isRecord(item)) continue
    if (item.type === 'text' && typeof item.text === 'string') pieces.push(item.text)
    else if (item.type === 'resource' && isRecord(item.resource)) {
      const res = item.resource
      pieces.push(typeof res.text === 'string' ? res.text : `[resource ${String(res.uri ?? '')}]`)
    } else if (item.type === 'resource_link') pieces.push(`[resource ${String(item.uri ?? '')}]`)
    else if (typeof item.type === 'string') pieces.push(`[${item.type} omitted]`)
  }
  if (pieces.length === 0 && result.structuredContent !== undefined) {
    pieces.push(JSON.stringify(result.structuredContent))
  }
  if (pieces.length === 0 && result.toolResult !== undefined) {
    pieces.push(JSON.stringify(result.toolResult))
  }
  const text = pieces.join('\n').slice(0, CHAT_TOOL_OUTPUT_MAX)
  if (result.isError === true) return { ok: false, error: text.slice(0, 1000) || 'failed' }
  return { ok: true, output: text }
}

export function serverSecrets(
  settings: McpServerSettings,
  secret: McpHostDeps['secret'],
): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const key of settings.secrets) {
    const value = secret(settings.name, key)
    if (value !== null) secrets[key] = value
  }
  return secrets
}

function fingerprintOf(settings: McpServerSettings, secret: McpHostDeps['secret']): string {
  const secrets = settings.secrets.map((key) => [key, secret(settings.name, key) !== null])
  return JSON.stringify({
    command: settings.command,
    url: settings.url,
    env: settings.env,
    secrets,
  })
}

export class McpHost {
  private entries = new Map<string, Entry>()
  private calls = new Map<string, AbortController>()

  constructor(private readonly deps: McpHostDeps) {}

  status(): McpServerStatus[] {
    return this.deps.servers().map((s) => {
      const entry = this.entries.get(s.name)
      const status: McpServerStatus = {
        name: s.name,
        transport: mcpTransportOf(s),
        state: s.enabled ? (entry?.state ?? 'idle') : 'off',
        tools: s.enabled && entry?.state === 'ready' ? entry.tools : [],
        secretsSet: s.secrets.filter((key) => this.deps.secret(s.name, key) !== null),
      }
      if (s.enabled && entry?.error) status.error = entry.error
      const auth = this.deps.auth?.state(s, s.enabled && entry?.unauthorized === true)
      if (auth) status.auth = auth
      return status
    })
  }

  private emit(): void {
    this.deps.onStatus(this.status())
  }

  notify(): void {
    this.emit()
  }

  refresh(): McpServerStatus[] {
    const servers = this.deps.servers()
    this.deps.auth?.prune(servers)
    const wanted = new Map(servers.map((s) => [s.name, s]))
    for (const [name, entry] of this.entries) {
      const next = wanted.get(name)
      if (!next?.enabled || fingerprintOf(next, this.deps.secret) !== entry.fingerprint) {
        this.drop(name)
      } else {
        entry.settings = next
      }
    }
    for (const settings of wanted.values()) {
      if (settings.enabled && !this.entries.has(settings.name)) this.connect(settings)
    }
    return this.status()
  }

  reconnect(name: string): McpServerStatus[] {
    this.drop(name)
    return this.refresh()
  }

  private drop(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) return
    this.entries.delete(name)
    entry.generation = -1
    void entry.client?.close().catch(() => undefined)
  }

  private transportFor(settings: McpServerSettings, onUnauthorized: () => void) {
    const secrets = serverSecrets(settings, this.deps.secret)
    if (settings.url) {
      const url = new URL(settings.url).href
      return {
        type: 'http' as const,
        url,
        headers: secrets,
        authProvider: this.deps.auth?.provider(settings),
        fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const response = await fetch(input, init)
          if (response.status === 401 && response.url === url) onUnauthorized()
          return response
        },
      }
    }
    const [command, ...args] = settings.command ?? []
    return new StdioMCPTransport({
      command,
      args,
      env: { ...settings.env, ...secrets },
      stderr: 'ignore',
      cwd: homedir(),
    })
  }

  private async open(
    settings: McpServerSettings,
    hooks: {
      onError: (err: unknown) => void
      onUnauthorized: () => void
      onClient: (client: MCPClient) => void
      live: () => boolean
    },
  ): Promise<Connection | null> {
    const timeout = this.deps.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS
    const transport = this.transportFor(settings, hooks.onUnauthorized)
    const client = await createMCPClient({
      transport,
      protocolVersionDiscovery: false,
      clientName: PRODUCT_DISPLAY_NAME,
      initializationOptions: { timeout },
      onUncaughtError: hooks.onError,
    })
    if (!hooks.live()) {
      await client.close().catch(() => undefined)
      return null
    }
    hooks.onClient(client)
    if (transport instanceof StdioMCPTransport) {
      const previous = transport.onclose
      transport.onclose = () => {
        previous?.()
        hooks.onError(new Error('The server exited.'))
      }
    }
    try {
      const listed = await client.listTools({ options: { timeout } })
      const tools = (Array.isArray(listed.tools) ? listed.tools : [])
        .map(toolInfo)
        .filter((t): t is McpToolInfo => t !== null)
        .slice(0, MCP_TOOLS_PER_SERVER_MAX)
      return { client, tools }
    } catch (err) {
      await client.close().catch(() => undefined)
      throw err
    }
  }

  private connect(settings: McpServerSettings): void {
    const entry: Entry = {
      fingerprint: fingerprintOf(settings, this.deps.secret),
      settings,
      client: null,
      state: 'connecting',
      tools: [],
      generation: 0,
      unauthorized: false,
    }
    this.entries.set(settings.name, entry)
    const live = (): boolean => this.entries.get(settings.name) === entry && entry.generation >= 0
    const failWith = (err: unknown): void => {
      if (!live()) return
      entry.state = 'error'
      entry.error = errorText(err)
      entry.tools = []
      void entry.client?.close().catch(() => undefined)
      entry.client = null
      this.emit()
    }
    void (async () => {
      try {
        const connection = await this.open(settings, {
          onError: failWith,
          onUnauthorized: () => {
            entry.unauthorized = true
          },
          onClient: (client) => {
            entry.client = client
          },
          live,
        })
        if (!connection || !live() || entry.client !== connection.client) return
        entry.tools = connection.tools
        entry.state = 'ready'
        entry.error = undefined
        entry.unauthorized = false
        this.emit()
      } catch (err) {
        failWith(err)
      }
    })()
    this.emit()
  }

  async test(name: unknown): Promise<McpTestResult> {
    const settings = this.deps.servers().find((s) => s.name === name)
    if (!settings) return { ok: false, error: 'unknown-server' }
    let failure: unknown
    let listed = false
    try {
      const connection = await this.open(settings, {
        onError: (err) => {
          if (!listed) failure ??= err
        },
        onUnauthorized: () => {},
        onClient: () => {},
        live: () => true,
      })
      listed = true
      if (!connection) return { ok: false, error: 'failed' }
      await connection.client.close().catch(() => undefined)
      if (failure !== undefined) return { ok: false, error: errorText(failure) }
      return { ok: true, tools: connection.tools.length }
    } catch (err) {
      return { ok: false, error: errorText(failure ?? err) }
    }
  }

  async call(
    callId: unknown,
    server: unknown,
    tool: unknown,
    input: unknown,
  ): Promise<McpCallResult> {
    if (typeof callId !== 'string' || !CALL_ID_PATTERN.test(callId)) {
      return { ok: false, error: 'invalid call' }
    }
    if (typeof server !== 'string' || typeof tool !== 'string') {
      return { ok: false, error: 'invalid call' }
    }
    const settings = this.deps.servers().find((s) => s.name === server)
    const entry = this.entries.get(server)
    if (!settings?.enabled || !entry?.client || entry.state !== 'ready') {
      return { ok: false, error: 'This MCP server is not connected.' }
    }
    if (settings.disabledTools.includes(tool) || !entry.tools.some((t) => t.name === tool)) {
      return { ok: false, error: 'This MCP tool is turned off.' }
    }
    const args = isRecord(input) ? input : {}
    const abort = new AbortController()
    this.calls.set(callId, abort)
    try {
      const result = await entry.client.callTool({
        name: tool,
        arguments: args,
        options: { signal: abort.signal, timeout: this.deps.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS },
      })
      return formatCallResult(result)
    } catch (err) {
      if (abort.signal.aborted) return { ok: false, error: 'cancelled' }
      if (this.deps.auth?.state(settings, false) === 'expired') this.reconnect(server)
      return { ok: false, error: errorText(err) }
    } finally {
      this.calls.delete(callId)
    }
  }

  cancel(callId: unknown): void {
    if (typeof callId === 'string') this.calls.get(callId)?.abort()
  }

  closeAll(): void {
    for (const call of this.calls.values()) call.abort()
    for (const name of [...this.entries.keys()]) this.drop(name)
  }
}
