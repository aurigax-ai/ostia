import { CHAT_TOOL_DESCRIPTION_MAX, type ChatToolSpec } from '@shared/assist'
import {
  BUILTIN_TOOL_ACCESS,
  type BuiltinChatTool,
  type ChatFsError,
  type ChatFsResult,
  type McpServerStatus,
  type SkillSummary,
  mcpToolName,
} from '@shared/chatTools'
import { useBlocksStore } from '../stores/blocksStore'
import {
  type ApprovalDetail,
  grantsFor,
  isToolOn,
  requestApproval,
  useChatToolsStore,
} from '../stores/chatToolsStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { workspaceTerminal } from './askContext'
import { idleTerminals, insertInto, runInNewTerminal } from './chatActions'
import { type ApprovalAnswer, type ToolAccess, decideTool } from './chatToolPermissions'
import { resolveLinkPath } from './fileLinks'
import { openFileAt } from './openFile'
import { openSidebarUrl } from './sidebarItems'

export type ToolOutcome =
  | { state: 'done'; output: unknown }
  | { state: 'error'; error: string }
  | { state: 'denied' }

export interface ToolRun {
  sessionId: string
  workspaceId: string | null
  root: string
  toolCallId: string
  signal: AbortSignal
  onApproval: (approvalId: string) => void
  onAnswer: (approvalId: string, approved: boolean) => void
}

export interface ChatToolDef {
  spec: ChatToolSpec
  group: string
  run: (input: Record<string, unknown>, run: ToolRun) => Promise<ToolOutcome>
}

const RECENT_COMMANDS = 10
export const GIT_EXTENSION = 'git'
export const SKILLS_GROUP = 'skills'

export function mcpGroup(server: string): string {
  return `mcp:${server}`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined
}

const FS_ERRORS: Record<ChatFsError, string> = {
  'outside-folder': 'That path is outside the workspace folder.',
  'not-allowed': 'That path is outside the folders Pine may touch.',
  'not-found': 'No such file or folder.',
  'not-a-file': 'That path is not a regular file.',
  'not-a-directory': 'That path is not a folder.',
  'too-large': 'The file is too large.',
  binary: 'The file is binary, not text.',
  invalid: 'The path or query is invalid.',
  failed: 'The operation failed.',
}

export const DENIED: ToolOutcome = { state: 'denied' }

async function gate(
  run: ToolRun,
  name: string,
  access: ToolAccess,
  input: Record<string, unknown>,
  detail: ApprovalDetail,
  outside = false,
): Promise<ApprovalAnswer | null> {
  const decision = decideTool(name, access, grantsFor(run.sessionId), outside)
  if (decision.run) return null
  const approvalId = `ap-${run.toolCallId}`
  run.onApproval(approvalId)
  const answer = await requestApproval(
    {
      toolCallId: run.toolCallId,
      sessionId: run.sessionId,
      toolName: name,
      kind: decision.kind,
      grantable: decision.grantKey !== null,
      input,
      detail,
    },
    decision,
    run.signal,
  )
  run.onAnswer(approvalId, answer.approved)
  return answer
}

function pathOf(input: Record<string, unknown>, run: ToolRun, key = 'path'): string {
  const raw = str(input[key]).trim()
  return resolveLinkPath(raw || '.', run.root)
}

async function readGated<T>(
  name: BuiltinChatTool,
  input: Record<string, unknown>,
  run: ToolRun,
  path: string,
  call: (outside: boolean) => Promise<ChatFsResult<T>>,
): Promise<ToolOutcome> {
  const outside = grantsFor(run.sessionId).has('read-outside')
  let res = await call(outside)
  if (!res.ok && res.error === 'outside-folder') {
    const answer = await gate(run, name, 'read', input, { path }, true)
    if (answer && !answer.approved) return DENIED
    res = await call(true)
  }
  if (!res.ok) return { state: 'error', error: `${FS_ERRORS[res.error]} (${res.path ?? path})` }
  const { ok: _ok, ...output } = res
  return { state: 'done', output }
}

const OBJECT = 'object'

const BUILTIN_SPECS: Record<BuiltinChatTool, Omit<ChatToolSpec, 'name'>> = {
  read_file: {
    description:
      'Read a text file. Relative paths start at the workspace folder. Returns up to 2000 lines from offset (1-based).',
    inputSchema: {
      type: OBJECT,
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: { type: 'integer', description: 'First line, 1-based' },
        limit: { type: 'integer', description: 'Number of lines' },
      },
      required: ['path'],
    },
  },
  list_directory: {
    description:
      'List a folder. Relative paths start at the workspace folder; empty means that folder.',
    inputSchema: {
      type: OBJECT,
      properties: { path: { type: 'string', description: 'Folder path' } },
    },
  },
  search_files: {
    description:
      'Search file names and contents (case-insensitive substring) under a folder, skipping .git and node_modules. Returns up to 100 matches.',
    inputSchema: {
      type: OBJECT,
      properties: {
        query: { type: 'string', description: 'Text to find' },
        path: { type: 'string', description: 'Folder to search, default the workspace folder' },
      },
      required: ['query'],
    },
  },
  terminal_context: {
    description:
      "The workspace terminal's current folder and its recent commands with exit codes (never their output).",
    inputSchema: { type: OBJECT, properties: {} },
  },
  git_status: {
    description: 'Branch, change counts and changed files of the repository the terminal is in.',
    inputSchema: { type: OBJECT, properties: {} },
  },
  load_skill: {
    description: 'Load the full instructions of a skill by name.',
    inputSchema: {
      type: OBJECT,
      properties: { name: { type: 'string', description: 'Skill name' } },
      required: ['name'],
    },
  },
  propose_command: {
    description:
      'Propose one shell command. The user sees it and chooses to insert it at the prompt, run it in a new terminal, or decline. You never see its output.',
    inputSchema: {
      type: OBJECT,
      properties: {
        command: { type: 'string', description: 'The command line' },
        explanation: { type: 'string', description: 'One short sentence on what it does' },
      },
      required: ['command'],
    },
  },
  write_file: {
    description:
      'Create or replace a text file with the full new content. The user reviews a diff and approves or denies it.',
    inputSchema: {
      type: OBJECT,
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'The complete new file content' },
      },
      required: ['path', 'content'],
    },
  },
  open_file: {
    description: "Open a file in the user's editor, optionally at a line. Asks the user first.",
    inputSchema: {
      type: OBJECT,
      properties: {
        path: { type: 'string', description: 'File path' },
        line: { type: 'integer', description: 'Line to reveal, 1-based' },
      },
      required: ['path'],
    },
  },
  open_url: {
    description: "Open an http(s) URL in the workspace's browser pane. Asks the user first.",
    inputSchema: {
      type: OBJECT,
      properties: { url: { type: 'string', description: 'http or https URL' } },
      required: ['url'],
    },
  },
}

function recentCommands(paneId: string): { command: string; exitCode: number | null }[] {
  const list = useBlocksStore.getState().byPane[paneId] ?? []
  return list
    .filter((b) => b.endLine && b.command.trim())
    .slice(-RECENT_COMMANDS)
    .map((b) => ({ command: b.command, exitCode: b.exitCode }))
}

function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function proposeCommand(input: Record<string, unknown>, run: ToolRun): Promise<ToolOutcome> {
  const command = str(input.command).replace(/\s+$/, '')
  if (!command.trim()) return { state: 'error', error: 'command is empty' }
  const answer = await gate(run, 'propose_command', 'confirm', input, { command })
  if (!answer?.approved) return DENIED
  if (answer.choice === 'run') {
    const paneId = runInNewTerminal(run.workspaceId, command)
    return paneId
      ? { state: 'done', output: { action: 'runs-in-new-terminal' } }
      : { state: 'error', error: 'Could not open a terminal.' }
  }
  const target = idleTerminals(run.workspaceId)[0]
  if (target && insertInto(target.paneId, command)) {
    return { state: 'done', output: { action: 'inserted-at-prompt' } }
  }
  await navigator.clipboard?.writeText(command).catch(() => undefined)
  return { state: 'done', output: { action: 'copied-to-clipboard' } }
}

async function writeFile(input: Record<string, unknown>, run: ToolRun): Promise<ToolOutcome> {
  if (typeof input.content !== 'string') return { state: 'error', error: 'content is required' }
  const path = pathOf(input, run)
  const preview = await window.pine.chatTools.preview({ path, root: run.root, outside: true })
  if (!preview.ok) {
    return { state: 'error', error: `${FS_ERRORS[preview.error]} (${preview.path ?? path})` }
  }
  const answer = await gate(run, 'write_file', 'confirm', input, {
    path: preview.path,
    exists: preview.exists,
    before: preview.text,
    after: input.content,
  })
  if (!answer?.approved) return DENIED
  const res = await window.pine.chatTools.write({
    path: preview.path,
    root: run.root,
    outside: true,
    content: input.content,
  })
  if (!res.ok) return { state: 'error', error: `${FS_ERRORS[res.error]} (${res.path ?? path})` }
  const { ok: _ok, ...output } = res
  return { state: 'done', output }
}

function builtinRunners(): Record<
  BuiltinChatTool,
  (input: Record<string, unknown>, run: ToolRun) => Promise<ToolOutcome>
> {
  return {
    read_file: (input, run) => {
      const path = pathOf(input, run)
      return readGated('read_file', input, run, path, (outside) =>
        window.pine.chatTools.read({
          path,
          root: run.root,
          outside,
          offset: int(input.offset),
          limit: int(input.limit),
        }),
      )
    },
    list_directory: (input, run) => {
      const path = pathOf(input, run)
      return readGated('list_directory', input, run, path, (outside) =>
        window.pine.chatTools.list({ path, root: run.root, outside }),
      )
    },
    search_files: (input, run) => {
      const path = pathOf(input, run)
      return readGated('search_files', input, run, path, (outside) =>
        window.pine.chatTools.search({ path, root: run.root, outside, query: str(input.query) }),
      )
    },
    terminal_context: async (_input, run) => {
      const pane = workspaceTerminal(run.workspaceId)
      if (!pane) return { state: 'error', error: 'This workspace has no terminal.' }
      const running = useBlocksStore.getState().running[pane.paneId] !== undefined
      return {
        state: 'done',
        output: { cwd: pane.cwd ?? null, running, recent: recentCommands(pane.paneId) },
      }
    },
    git_status: async (_input, run) => {
      const pane = workspaceTerminal(run.workspaceId)
      const res = await window.pine.extensions.invoke(GIT_EXTENSION, 'changes', {
        workspaceId: run.workspaceId,
        paneId: pane?.paneId ?? null,
      })
      if (!res.ok) return { state: 'error', error: res.message ?? res.error }
      return { state: 'done', output: res.data ?? res.text ?? null }
    },
    load_skill: async (input) => {
      const res = await window.pine.chatTools.loadSkill(str(input.name))
      if (!res.ok) return { state: 'error', error: `No skill named ${str(input.name)}.` }
      return { state: 'done', output: res.body }
    },
    propose_command: proposeCommand,
    write_file: writeFile,
    open_file: async (input, run) => {
      const path = pathOf(input, run)
      const answer = await gate(run, 'open_file', 'act', input, { path })
      if (answer && !answer.approved) return DENIED
      openFileAt(path, int(input.line))
      return { state: 'done', output: { opened: path } }
    },
    open_url: async (input, run) => {
      const url = str(input.url).trim()
      if (!isWebUrl(url)) return { state: 'error', error: 'Only http and https URLs open.' }
      const answer = await gate(run, 'open_url', 'act', input, { url })
      if (answer && !answer.approved) return DENIED
      openSidebarUrl(run.workspaceId ?? undefined, url, 'agent')
      return { state: 'done', output: { opened: url } }
    },
  }
}

function skillsDescription(skills: SkillSummary[]): string {
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`)
  return `${BUILTIN_SPECS.load_skill.description} Available skills:\n${lines.join('\n')}`.slice(
    0,
    CHAT_TOOL_DESCRIPTION_MAX,
  )
}

export function gitAvailable(): boolean {
  return useExtensionsStore
    .getState()
    .list.some((e) => e.id === GIT_EXTENSION && e.enabled && e.status !== 'pending-approval')
}

export function groupOf(name: BuiltinChatTool): string {
  return name === 'load_skill' ? SKILLS_GROUP : name
}

export function builtinAvailable(name: BuiltinChatTool, skills: SkillSummary[]): boolean {
  if (name === 'git_status') return gitAvailable()
  if (name === 'load_skill') return skills.length > 0
  return true
}

function mcpTools(server: McpServerStatus): ChatToolDef[] {
  const settings = useSettingsStore
    .getState()
    .assistant.mcpServers.find((s) => s.name === server.name)
  const disabled = new Set(settings?.disabledTools ?? [])
  return server.tools
    .filter((tool) => !disabled.has(tool.name))
    .map((tool) => {
      const name = mcpToolName(server.name, tool.name)
      return {
        group: mcpGroup(server.name),
        spec: {
          name,
          description: `[${server.name}] ${tool.description}`.slice(0, CHAT_TOOL_DESCRIPTION_MAX),
          inputSchema: tool.inputSchema,
        },
        run: async (input, run) => {
          const answer = await gate(run, name, 'mcp', input, {
            server: server.name,
            tool: tool.name,
          })
          if (answer && !answer.approved) return DENIED
          const callId = run.toolCallId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'call'
          const cancel = (): void => window.pine.chatTools.mcpCancel(callId)
          run.signal.addEventListener('abort', cancel, { once: true })
          try {
            const res = await window.pine.chatTools.mcpCall(callId, server.name, tool.name, input)
            return res.ok
              ? { state: 'done', output: res.output }
              : { state: 'error', error: res.error }
          } finally {
            run.signal.removeEventListener('abort', cancel)
          }
        },
      }
    })
}

export function chatToolDefs(sessionId: string): ChatToolDef[] {
  const { skills, mcp } = useChatToolsStore.getState()
  const runners = builtinRunners()
  const defs: ChatToolDef[] = []
  for (const name of Object.keys(BUILTIN_TOOL_ACCESS) as BuiltinChatTool[]) {
    if (!builtinAvailable(name, skills) || !isToolOn(sessionId, groupOf(name))) continue
    const base = BUILTIN_SPECS[name]
    defs.push({
      group: groupOf(name),
      spec: {
        name,
        description: name === 'load_skill' ? skillsDescription(skills) : base.description,
        inputSchema: base.inputSchema,
      },
      run: runners[name],
    })
  }
  for (const server of mcp) {
    if (server.state !== 'ready' || !isToolOn(sessionId, mcpGroup(server.name))) continue
    for (const def of mcpTools(server)) {
      if (!defs.some((d) => d.spec.name === def.spec.name)) defs.push(def)
    }
  }
  return defs
}

export function workspaceFolder(workspaceId: string | null): string {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState()
  return workspaces.find((w) => w.id === (workspaceId ?? activeWorkspaceId))?.workDir ?? '~'
}
