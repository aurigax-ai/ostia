import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { EditChange, PlanItem, PlanStatus, StreamEvent, TurnEnd } from './agentStream'
import { parse, textParts } from './transcriptTurns'
import type { TurnStepKind } from './turnHook'

const NOT_A_PROMPT = /^<(local-command|command-name|command-message)/
const EXIT_CODE = /^Exit code (\d+)/

const TOOL_KINDS: Record<string, { kind: TurnStepKind; target: string[]; input: string[] }> = {
  Edit: { kind: 'edit', target: ['file_path'], input: [] },
  MultiEdit: { kind: 'edit', target: ['file_path'], input: [] },
  Write: { kind: 'edit', target: ['file_path'], input: [] },
  NotebookEdit: { kind: 'edit', target: ['notebook_path'], input: [] },
  Bash: { kind: 'command', target: [], input: ['command'] },
  Grep: { kind: 'search', target: [], input: ['pattern'] },
  Glob: { kind: 'search', target: [], input: ['pattern'] },
  Read: { kind: 'read', target: ['file_path'], input: [] },
  Task: { kind: 'subagent', target: [], input: ['description', 'prompt'] },
  Agent: { kind: 'subagent', target: [], input: ['description', 'prompt'] },
  WebFetch: { kind: 'web', target: ['url'], input: [] },
  WebSearch: { kind: 'web', target: [], input: ['query'] },
}

const PLAN_STATUS: Record<string, PlanStatus> = {
  pending: 'pending',
  in_progress: 'active',
  completed: 'done',
}

function firstString(
  input: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = input[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function inputText(name: string, input: Record<string, unknown>): string | undefined {
  const spec = TOOL_KINDS[name]
  if (spec) return firstString(input, spec.input)
  return Object.keys(input).length > 0 ? JSON.stringify(input) : undefined
}

function planItems(input: Record<string, unknown>): PlanItem[] {
  const todos = Array.isArray(input.todos) ? input.todos : []
  return todos.flatMap((todo) =>
    isRecord(todo) && typeof todo.content === 'string'
      ? [{ text: todo.content, status: PLAN_STATUS[String(todo.status)] ?? 'pending' }]
      : [],
  )
}

function patchDiff(path: string, hunks: unknown): string {
  const lines = [`--- a/${path}`, `+++ b/${path}`]
  for (const hunk of Array.isArray(hunks) ? hunks : []) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) lines.push(String(line))
  }
  return lines.join('\n')
}

function createDiff(path: string, content: string): string {
  const body = content.split('\n')
  return [
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${body.length} @@`,
    ...body.map((l) => `+${l}`),
  ].join('\n')
}

function editOf(
  result: Record<string, unknown>,
): { path: string; change: EditChange; diff: string } | null {
  const path = typeof result.filePath === 'string' ? result.filePath : null
  if (!path) return null
  if (result.type === 'create' && typeof result.content === 'string') {
    return { path, change: 'add', diff: createDiff(path, result.content) }
  }
  if (!Array.isArray(result.structuredPatch)) return null
  return { path, change: 'update', diff: patchDiff(path, result.structuredPatch) }
}

interface OpenTool {
  name: string
  plan: boolean
}

export class ClaudeStream {
  private turn: string | null = null
  private implicit = 0
  private readonly tools = new Map<string, OpenTool>()

  feed(lines: readonly string[]): StreamEvent[] {
    const out: StreamEvent[] = []
    for (const line of lines) {
      const entry = parse(line)
      if (entry) this.entry(entry, out)
    }
    return out
  }

  private begin(out: StreamEvent[], id: string): void {
    this.finish(out, 'interrupted')
    this.turn = id
    out.push({ type: 'turn.started', turn: id })
  }

  private finish(out: StreamEvent[], status: TurnEnd): void {
    if (this.turn === null) return
    out.push({ type: 'turn.ended', turn: this.turn, status })
    this.turn = null
  }

  private current(out: StreamEvent[]): string {
    if (this.turn === null) {
      this.implicit += 1
      this.turn = `t${this.implicit}`
      out.push({ type: 'turn.started', turn: this.turn })
    }
    return this.turn
  }

  private entry(entry: Record<string, unknown>, out: StreamEvent[]): void {
    if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      this.finish(out, 'done')
      return
    }
    const message = isRecord(entry.message) ? entry.message : null
    if (!message || entry.isSidechain === true) return
    if (entry.type === 'user' && entry.isMeta !== true) this.user(entry, message, out)
    else if (entry.type === 'assistant') this.assistant(entry, message, out)
  }

  private user(
    entry: Record<string, unknown>,
    message: Record<string, unknown>,
    out: StreamEvent[],
  ): void {
    const content = message.content
    const blocks = Array.isArray(content) ? content : []
    const results = blocks.filter((b) => isRecord(b) && b.type === 'tool_result')
    if (results.length > 0) {
      for (const block of results) this.result(entry, block as Record<string, unknown>, out)
      return
    }
    const prompt = textParts(content)
    if (!prompt.trim() || NOT_A_PROMPT.test(prompt.trimStart())) return
    const id = typeof entry.uuid === 'string' ? entry.uuid : `p${this.implicit + 1}`
    this.begin(out, id)
    out.push({ type: 'prompt', turn: id, id, text: prompt })
  }

  private assistant(
    entry: Record<string, unknown>,
    message: Record<string, unknown>,
    out: StreamEvent[],
  ): void {
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : 'a'
    const blocks = Array.isArray(message.content) ? message.content : []
    blocks.forEach((block, index) => {
      if (!isRecord(block)) return
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({
          type: 'text',
          turn: this.current(out),
          id: `${uuid}:${index}`,
          text: block.text,
        })
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        this.tool(block, out)
      }
    })
    if (message.stop_reason === 'end_turn') this.finish(out, 'done')
  }

  private tool(block: Record<string, unknown>, out: StreamEvent[]): void {
    const name = String(block.name)
    const id = typeof block.id === 'string' ? block.id : `${name}${this.tools.size}`
    const input = isRecord(block.input) ? block.input : {}
    const turn = this.current(out)
    if (name === 'TodoWrite') {
      this.tools.set(id, { name, plan: true })
      out.push({ type: 'plan', turn, id, items: planItems(input) })
      return
    }
    this.tools.set(id, { name, plan: false })
    const spec = TOOL_KINDS[name]
    const target = spec ? firstString(input, spec.target) : undefined
    const detail = inputText(name, input)
    out.push({
      type: 'tool',
      turn,
      id,
      kind: spec?.kind ?? 'other',
      name,
      ...(target ? { target } : {}),
      ...(detail ? { input: detail } : {}),
    })
  }

  private result(
    entry: Record<string, unknown>,
    block: Record<string, unknown>,
    out: StreamEvent[],
  ): void {
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
    const open = this.tools.get(id)
    if (!open || open.plan) return
    this.tools.delete(id)
    const turn = this.current(out)
    const output = textParts(block.content)
    const isError = block.is_error === true
    const spec = TOOL_KINDS[open.name]
    const code = EXIT_CODE.exec(output)
    const exitCode =
      spec?.kind === 'command' ? (code ? Number(code[1]) : isError ? undefined : 0) : undefined
    const edit = isRecord(entry.toolUseResult) ? editOf(entry.toolUseResult) : null
    if (edit && !isError) out.push({ type: 'edit', turn, id, ...edit })
    out.push({
      type: 'tool.result',
      turn,
      id,
      output,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(isError ? { isError: true as const } : {}),
    })
  }
}
