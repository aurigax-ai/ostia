import { homedir } from 'node:os'
import { type MCPClient, createMCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import {
  CHAT_TOOL_DESCRIPTION_MAX,
  CHAT_TOOL_OUTPUT_MAX,
  CHAT_TOOL_SCHEMA_MAX,
} from '../shared/assist'
import {
  MCP_TOOLS_PER_SERVER_MAX,
  type McpCallResult,
  type McpServerSettings,
  type McpServerState,
  type McpServerStatus,
  type McpToolInfo,
  mcpTransportOf,
} from '../shared/chatTools'

export const MCP_CONNECT_TIMEOUT_MS = 15_000
export const MCP_CALL_TIMEOUT_MS = 120_000
const ERROR_MAX = 240
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export interface McpHostDeps {
  servers: () => McpServerSettings[]
  secret: (server: string, key: string) => string | null
  onStatus: (status: McpServerStatus[]) => void
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
      return status
    })
  }

  private emit(): void {
    this.deps.onStatus(this.status())
  }

  refresh(): McpServerStatus[] {
    const wanted = new Map(this.deps.servers().map((s) => [s.name, s]))
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

  private transportFor(settings: McpServerSettings) {
    const secrets: Record<string, string> = {}
    for (const key of settings.secrets) {
      const value = this.deps.secret(settings.name, key)
      if (value !== null) secrets[key] = value
    }
    if (settings.url) {
      return { type: 'http' as const, url: settings.url, headers: secrets }
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

  private connect(settings: McpServerSettings): void {
    const entry: Entry = {
      fingerprint: fingerprintOf(settings, this.deps.secret),
      settings,
      client: null,
      state: 'connecting',
      tools: [],
      generation: 0,
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
        const transport = this.transportFor(settings)
        const client = await createMCPClient({
          transport,
          protocolVersionDiscovery: false,
          clientName: 'pine',
          initializationOptions: { timeout: this.deps.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS },
          onUncaughtError: failWith,
        })
        if (!live()) {
          await client.close().catch(() => undefined)
          return
        }
        entry.client = client
        if (transport instanceof StdioMCPTransport) {
          const previous = transport.onclose
          transport.onclose = () => {
            previous?.()
            failWith(new Error('The server exited.'))
          }
        }
        const listed = await client.listTools({
          options: { timeout: this.deps.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS },
        })
        if (!live()) return
        entry.tools = (Array.isArray(listed.tools) ? listed.tools : [])
          .map(toolInfo)
          .filter((t): t is McpToolInfo => t !== null)
          .slice(0, MCP_TOOLS_PER_SERVER_MAX)
        entry.state = 'ready'
        entry.error = undefined
        this.emit()
      } catch (err) {
        failWith(err)
      }
    })()
    this.emit()
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
