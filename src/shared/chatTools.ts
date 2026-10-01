import { CHAT_TOOL_NAME_PATTERN } from './assist'
import type { ChatEdit } from './chatEdits'
import { isSkillPath } from './managerSettings'
import { isDangerousSegment } from './protoGuard'

export const BUILTIN_CHAT_TOOLS = [
  'read_file',
  'list_directory',
  'search_files',
  'terminal_context',
  'git_status',
  'load_skill',
  'propose_command',
  'edit_file',
  'write_file',
  'open_file',
  'open_url',
] as const

export type BuiltinChatTool = (typeof BUILTIN_CHAT_TOOLS)[number]

export type ChatToolAccess = 'read' | 'act' | 'write' | 'command'

export const BUILTIN_TOOL_ACCESS: Readonly<Record<BuiltinChatTool, ChatToolAccess>> = {
  read_file: 'read',
  list_directory: 'read',
  search_files: 'read',
  terminal_context: 'read',
  git_status: 'read',
  load_skill: 'read',
  propose_command: 'command',
  edit_file: 'write',
  write_file: 'write',
  open_file: 'act',
  open_url: 'act',
}

export function isBuiltinChatTool(name: unknown): name is BuiltinChatTool {
  return BUILTIN_CHAT_TOOLS.includes(name as BuiltinChatTool)
}

export const MCP_TOOL_PREFIX = 'mcp__'
export const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
export const MCP_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const MCP_HEADER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
export const MCP_SERVERS_MAX = 16
export const MCP_ARGS_MAX = 64
export const MCP_ARG_MAX = 4096
export const MCP_ENV_MAX = 32
export const MCP_ENV_VALUE_MAX = 4096
export const MCP_SECRETS_MAX = 8
export const MCP_URL_MAX = 2048
export const MCP_TOOLS_PER_SERVER_MAX = 64
export const CHAT_SKILL_FOLDERS_MAX = 32
export const SKILL_FILE_MAX = 256 * 1024
export const SKILL_DESCRIPTION_MAX = 1024
export const SKILLS_MAX = 128
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type McpTransportKind = 'stdio' | 'http'

export interface McpServerSettings {
  name: string
  enabled: boolean
  command?: string[]
  url?: string
  env: Record<string, string>
  secrets: string[]
  disabledTools: string[]
}

export interface ChatToolSettings {
  mcpServers: McpServerSettings[]
  skillFolders: string[]
}

export const DEFAULT_CHAT_TOOL_SETTINGS: ChatToolSettings = { mcpServers: [], skillFolders: [] }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function isMcpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MCP_URL_MAX) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function hasControlChars(text: string): boolean {
  for (const ch of text) if (ch.charCodeAt(0) < 0x20) return true
  return false
}

export function isMcpArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MCP_ARGS_MAX &&
    typeof value[0] === 'string' &&
    value[0].length > 0 &&
    value.every((a) => typeof a === 'string' && a.length <= MCP_ARG_MAX && !hasControlChars(a))
  )
}

export function mcpTransportOf(server: Pick<McpServerSettings, 'url'>): McpTransportKind {
  return server.url ? 'http' : 'stdio'
}

export function isMcpSecretKey(transport: McpTransportKind, key: unknown): key is string {
  if (typeof key !== 'string' || isDangerousSegment(key)) return false
  return transport === 'http' ? MCP_HEADER_KEY.test(key) : MCP_ENV_KEY.test(key)
}

function stringList(raw: unknown, max: number, ok: (s: string) => boolean): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && ok(item) && !out.includes(item)) out.push(item)
    if (out.length === max) break
  }
  return out
}

export function parseMcpServer(raw: unknown): McpServerSettings | null {
  if (!isObject(raw) || typeof raw.name !== 'string' || !MCP_SERVER_NAME.test(raw.name)) {
    return null
  }
  const hasUrl = raw.url !== undefined && raw.url !== ''
  const hasCommand = raw.command !== undefined
  if (hasUrl === hasCommand) return null
  if (hasUrl && !isMcpUrl(raw.url)) return null
  if (hasCommand && !isMcpArgv(raw.command)) return null
  const transport: McpTransportKind = hasUrl ? 'http' : 'stdio'
  const env: Record<string, string> = {}
  if (transport === 'stdio' && isObject(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      if (Object.keys(env).length === MCP_ENV_MAX) break
      if (!MCP_ENV_KEY.test(key) || isDangerousSegment(key)) continue
      if (typeof value !== 'string' || value.length > MCP_ENV_VALUE_MAX) continue
      env[key] = value
    }
  }
  const server: McpServerSettings = {
    name: raw.name,
    enabled: raw.enabled !== false,
    env,
    secrets: stringList(raw.secrets, MCP_SECRETS_MAX, (k) => isMcpSecretKey(transport, k)),
    disabledTools: stringList(
      raw.disabledTools,
      MCP_TOOLS_PER_SERVER_MAX * 4,
      (t) => t.length <= 128,
    ),
  }
  if (transport === 'http') server.url = raw.url as string
  else server.command = [...(raw.command as string[])]
  return server
}

export function parseChatToolSettings(raw: unknown): ChatToolSettings {
  const src = isObject(raw) ? raw : {}
  const mcpServers: McpServerSettings[] = []
  for (const item of Array.isArray(src.mcpServers) ? src.mcpServers : []) {
    if (mcpServers.length === MCP_SERVERS_MAX) break
    const server = parseMcpServer(item)
    if (server && !mcpServers.some((s) => s.name === server.name)) mcpServers.push(server)
  }
  return {
    mcpServers,
    skillFolders: stringList(src.skillFolders, CHAT_SKILL_FOLDERS_MAX, isSkillPath),
  }
}

export function mcpToolName(server: string, tool: string): string {
  const safeTool = tool.replace(/[^A-Za-z0-9_-]/g, '_')
  return `${MCP_TOOL_PREFIX}${server}__${safeTool}`.slice(0, 64)
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX) && CHAT_TOOL_NAME_PATTERN.test(name)
}

export type McpServerState = 'off' | 'idle' | 'connecting' | 'ready' | 'error'

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpServerStatus {
  name: string
  transport: McpTransportKind
  state: McpServerState
  error?: string
  tools: McpToolInfo[]
  secretsSet: string[]
}

export interface SkillSummary {
  name: string
  description: string
  path: string
}

export type ChatFsError =
  | 'outside-folder'
  | 'not-allowed'
  | 'not-found'
  | 'not-a-file'
  | 'not-a-directory'
  | 'too-large'
  | 'binary'
  | 'invalid'
  | 'failed'
  | 'changed'
  | 'through-symlink'
  | 'no-match'
  | 'ambiguous'
  | 'no-change'

export interface ChatFsFailure {
  ok: false
  error: ChatFsError
  path?: string
  edit?: number
  count?: number
}

export type ChatFsResult<T> = ({ ok: true } & T) | ChatFsFailure

export interface ChatFsTarget {
  path: string
  root: string
  outside: boolean
}

export interface ChatReadRequest extends ChatFsTarget {
  offset?: number
  limit?: number
}

export interface ChatReadOutput {
  path: string
  text: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
  version: string
}

export interface ChatDirEntry {
  name: string
  kind: 'file' | 'dir' | 'other'
  size?: number
}

export interface ChatListOutput {
  path: string
  entries: ChatDirEntry[]
  truncated: boolean
}

export interface ChatSearchRequest extends ChatFsTarget {
  query: string
}

export interface ChatSearchMatch {
  path: string
  line?: number
  text?: string
}

export interface ChatSearchOutput {
  path: string
  matches: ChatSearchMatch[]
  truncated: boolean
}

export interface ChatPreviewOutput {
  path: string
  exists: boolean
  text: string
  version: string | null
  outside: boolean
  symlink: boolean
}

export interface ChatPlanRequest {
  path: string
  root: string
  edits: ChatEdit[]
}

export interface ChatPlanOutput {
  path: string
  before: string
  after: string
  version: string
  outside: boolean
  symlink: boolean
}

export interface ChatWriteRequest extends ChatFsTarget {
  symlinks: boolean
  content: string
  base: string | null
}

export interface ChatWriteOutput {
  path: string
  created: boolean
  bytes: number
  version: string
}

export interface ChatUndoRequest extends ChatFsTarget {
  symlinks: boolean
  wrote: string
  restore: string | null
}

export interface ChatUndoOutput {
  path: string
  removed: boolean
  version: string | null
}

export type McpCallResult = { ok: true; output: string } | { ok: false; error: string }

export type McpSecretResult = { ok: true } | { ok: false; error: string }

export type SkillLoadResult =
  | { ok: true; name: string; body: string; path: string }
  | { ok: false; error: string }

export interface ChatToolsApi {
  read: (req: ChatReadRequest) => Promise<ChatFsResult<ChatReadOutput>>
  list: (req: ChatFsTarget) => Promise<ChatFsResult<ChatListOutput>>
  search: (req: ChatSearchRequest) => Promise<ChatFsResult<ChatSearchOutput>>
  preview: (req: Omit<ChatFsTarget, 'outside'>) => Promise<ChatFsResult<ChatPreviewOutput>>
  plan: (req: ChatPlanRequest) => Promise<ChatFsResult<ChatPlanOutput>>
  write: (req: ChatWriteRequest) => Promise<ChatFsResult<ChatWriteOutput>>
  undo: (req: ChatUndoRequest) => Promise<ChatFsResult<ChatUndoOutput>>
  skills: () => Promise<SkillSummary[]>
  loadSkill: (name: string) => Promise<SkillLoadResult>
  mcpStatus: () => Promise<McpServerStatus[]>
  mcpRefresh: () => Promise<McpServerStatus[]>
  mcpReconnect: (server: string) => Promise<McpServerStatus[]>
  onMcpStatus: (cb: (status: McpServerStatus[]) => void) => () => void
  mcpCall: (callId: string, server: string, tool: string, input: unknown) => Promise<McpCallResult>
  mcpCancel: (callId: string) => void
  setMcpSecret: (server: string, key: string, value: string | null) => Promise<McpSecretResult>
}

export const CHAT_READ_LINES_MAX = 2000
export const CHAT_LIST_MAX = 500
export const CHAT_SEARCH_MATCHES_MAX = 100
export const CHAT_SEARCH_FILES_MAX = 5000
export const CHAT_SEARCH_FILE_MAX = 1024 * 1024
export const CHAT_READ_FILE_MAX = 4 * 1024 * 1024
export const CHAT_WRITE_MAX = 1024 * 1024
export const CHAT_QUERY_MAX = 200
