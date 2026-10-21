import { CHAT_TOOL_DESCRIPTION_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import {
  BUILTIN_TOOL_ACCESS,
  type BuiltinChatTool,
  type McpServerStatus,
  mcpToolName,
  type SkillSummary,
} from '@shared/assist/chatTools'
import { openFileAt } from '@/lib/files/openFile'
import { openSidebarUrl } from '@/lib/sidebar/sidebarItems'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { isToolOn, useChatToolsStore } from '@/stores/assist/chatToolsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { workspaceTerminal } from './askContext'
import { idleTerminals, insertInto, runInNewTerminal } from './chatActions'
import { isWebUrl } from './chatLinks'
import {
  type ChatToolDef,
  DENIED,
  gate,
  int,
  pathOf,
  readGated,
  str,
  type ToolOutcome,
  type ToolRun,
} from './chatToolGate'
import { BUILTIN_SPECS, skillsDescription } from './chatToolSpecs'
import { editFile, writeFile } from './chatToolWrites'

const RECENT_COMMANDS = 10
export const SKILLS_GROUP = 'skills'

export function mcpGroup(server: string): string {
  return `mcp:${server}`
}

function recentCommands(paneId: string): { command: string; exitCode: number | null }[] {
  const list = useBlocksStore.getState().byPane[paneId] ?? []
  return list
    .filter((b) => b.endLine && b.command.trim())
    .slice(-RECENT_COMMANDS)
    .map((b) => ({ command: b.command, exitCode: b.exitCode }))
}

async function proposeCommand(input: Record<string, unknown>, run: ToolRun): Promise<ToolOutcome> {
  const command = str(input.command).replace(/\s+$/, '')
  if (!command.trim()) return { state: 'error', error: 'command is empty' }
  const answer = await gate(run, { name: 'propose_command', access: 'command' }, input, { command })
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

function readFile(input: Record<string, unknown>, run: ToolRun): Promise<ToolOutcome> {
  const path = pathOf(input, run)
  return readGated('read_file', input, run, path, async (outside) => {
    const res = await window.ostia.chatTools.read({
      path,
      root: run.root,
      outside,
      offset: int(input.offset),
      limit: int(input.limit),
    })
    if (!res.ok) return res
    useChatToolsStore.getState().setVersion(run.sessionId, res.path, res.version)
    const { version: _version, ...shown } = res
    return shown
  })
}

function builtinRunners(): Record<
  BuiltinChatTool,
  (input: Record<string, unknown>, run: ToolRun) => Promise<ToolOutcome>
> {
  return {
    read_file: readFile,
    list_directory: (input, run) => {
      const path = pathOf(input, run)
      return readGated('list_directory', input, run, path, (outside) =>
        window.ostia.chatTools.list({ path, root: run.root, outside }),
      )
    },
    search_files: (input, run) => {
      const path = pathOf(input, run)
      return readGated('search_files', input, run, path, (outside) =>
        window.ostia.chatTools.search({ path, root: run.root, outside, query: str(input.query) }),
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
      if (!run.workspaceId) return { state: 'error', error: 'not-a-repo' }
      const res = await window.ostia.git.changes(run.workspaceId)
      if (!res.ok) return { state: 'error', error: res.message ?? res.error }
      return { state: 'done', output: res.data }
    },
    load_skill: async (input) => {
      const res = await window.ostia.chatTools.loadSkill(str(input.name))
      if (!res.ok) return { state: 'error', error: `No skill named ${str(input.name)}.` }
      return { state: 'done', output: res.body }
    },
    propose_command: proposeCommand,
    edit_file: editFile,
    write_file: writeFile,
    open_file: async (input, run) => {
      const path = pathOf(input, run)
      const answer = await gate(run, { name: 'open_file', access: 'act' }, input, { path })
      if (answer && !answer.approved) return DENIED
      openFileAt(path, int(input.line))
      return { state: 'done', output: { opened: path } }
    },
    open_url: async (input, run) => {
      const url = str(input.url).trim()
      if (!isWebUrl(url)) return { state: 'error', error: 'Only http and https URLs open.' }
      const answer = await gate(run, { name: 'open_url', access: 'act' }, input, { url })
      if (answer && !answer.approved) return DENIED
      openSidebarUrl(run.workspaceId ?? undefined, url, 'agent')
      return { state: 'done', output: { opened: url } }
    },
  }
}

function gitAvailable(): boolean {
  return useSettingsStore.getState().git.enabled
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
          const answer = await gate(run, { name, access: 'mcp' }, input, {
            server: server.name,
            tool: tool.name,
          })
          if (answer && !answer.approved) return DENIED
          const callId = run.toolCallId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'call'
          const cancel = (): void => window.ostia.chatTools.mcpCancel(callId)
          run.signal.addEventListener('abort', cancel, { once: true })
          try {
            const res = await window.ostia.chatTools.mcpCall(callId, server.name, tool.name, input)
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
