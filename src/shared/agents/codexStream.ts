import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { EditChange, PlanStatus, StreamEvent, TurnEnd } from './agentStream'

type Record_ = Record<string, unknown>

const PLAN_STATUS: Record<string, PlanStatus> = {
  pending: 'pending',
  inProgress: 'active',
  completed: 'done',
}

const TURN_END: Record<string, TurnEnd> = {
  completed: 'done',
  interrupted: 'interrupted',
  failed: 'failed',
}

const FAILED = new Set(['failed', 'declined'])

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function userText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isRecord(part) && part.type === 'text' ? str(part.text) : ''))
    .join('')
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value
  if (isRecord(value) && value.type === 'text' && typeof value.text === 'string') return value.text
  return JSON.stringify(value)
}

function mcpOutput(item: Record_): string {
  if (isRecord(item.error)) return str(item.error.message)
  const result = isRecord(item.result) ? item.result : null
  const content = result && Array.isArray(result.content) ? result.content : []
  return content.map(jsonText).join('\n')
}

function dynamicOutput(item: Record_): string {
  const items = Array.isArray(item.contentItems) ? item.contentItems : []
  return items.map((part) => (isRecord(part) ? str(part.text) : '')).join('')
}

function changeOf(kind: unknown): EditChange {
  const type = isRecord(kind) ? kind.type : kind
  return type === 'add' || type === 'delete' ? type : 'update'
}

function fileChanges(item: Record_): Record_[] {
  return Array.isArray(item.changes) ? item.changes.filter(isRecord) : []
}

function searchTarget(item: Record_): string {
  const action = isRecord(item.action) ? item.action : null
  return str(item.query) || str(action?.url) || str(action?.pattern)
}

function codexItem(
  raw: unknown,
  turn: string,
  stage: 'started' | 'completed',
): StreamEvent[] {
  const item = isRecord(raw) ? raw : null
  const id = item ? str(item.id) : ''
  if (!item || !id) return []
  const done = stage === 'completed'
  switch (item.type) {
    case 'userMessage': {
      const text = userText(item.content)
      return done && text ? [{ type: 'prompt', turn, id, text }] : []
    }
    case 'agentMessage': {
      const text = str(item.text)
      return done && text ? [{ type: 'text', turn, id, text }] : []
    }
    case 'commandExecution': {
      const events: StreamEvent[] = [
        { type: 'tool', turn, id, kind: 'command', name: 'shell', input: str(item.command) },
      ]
      if (done) {
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined
        const failed = FAILED.has(str(item.status)) || (exitCode !== undefined && exitCode !== 0)
        events.push({
          type: 'tool.result',
          turn,
          id,
          output: str(item.aggregatedOutput),
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(failed ? { isError: true as const } : {}),
        })
      }
      return events
    }
    case 'fileChange': {
      const changes = fileChanges(item)
      const events: StreamEvent[] = [
        {
          type: 'tool',
          turn,
          id,
          kind: 'edit',
          name: 'apply_patch',
          target: changes.map((c) => str(c.path)).join(', '),
        },
      ]
      if (done) {
        const failed = FAILED.has(str(item.status))
        if (!failed) {
          changes.forEach((change, index) =>
            events.push({
              type: 'edit',
              turn,
              id: `${id}:${index}`,
              path: str(change.path),
              change: changeOf(change.kind),
              diff: str(change.diff),
            }),
          )
        }
        events.push({
          type: 'tool.result',
          turn,
          id,
          output: str(item.status),
          ...(failed ? { isError: true as const } : {}),
        })
      }
      return events
    }
    case 'mcpToolCall':
      return toolCall(item, turn, id, done, `${str(item.server)}/${str(item.tool)}`, mcpOutput)
    case 'dynamicToolCall':
      return toolCall(item, turn, id, done, str(item.tool), dynamicOutput)
    case 'webSearch': {
      const events: StreamEvent[] = [
        { type: 'tool', turn, id, kind: 'web', name: 'web_search', target: searchTarget(item) },
      ]
      if (done) events.push({ type: 'tool.result', turn, id, output: '' })
      return events
    }
    default:
      return []
  }
}

function toolCall(
  item: Record_,
  turn: string,
  id: string,
  done: boolean,
  name: string,
  output: (item: Record_) => string,
): StreamEvent[] {
  const args = item.arguments === undefined ? '' : JSON.stringify(item.arguments)
  const events: StreamEvent[] = [
    {
      type: 'tool',
      turn,
      id,
      kind: 'other',
      name,
      ...(args && args !== '{}' ? { input: args } : {}),
    },
  ]
  if (done) {
    const failed = FAILED.has(str(item.status)) || isRecord(item.error) || item.success === false
    events.push({
      type: 'tool.result',
      turn,
      id,
      output: output(item),
      ...(failed ? { isError: true as const } : {}),
    })
  }
  return events
}

function planEvent(params: Record_): StreamEvent[] {
  const turn = str(params.turnId)
  const steps = Array.isArray(params.plan) ? params.plan.filter(isRecord) : []
  return [
    {
      type: 'plan',
      turn,
      id: `plan:${turn}`,
      items: steps.map((step) => ({
        text: str(step.step),
        status: PLAN_STATUS[str(step.status)] ?? 'pending',
      })),
    },
  ]
}

export function codexNotification(method: string, raw: unknown): StreamEvent[] {
  const params = isRecord(raw) ? raw : {}
  switch (method) {
    case 'turn/started': {
      const turn = isRecord(params.turn) ? str(params.turn.id) : ''
      return turn ? [{ type: 'turn.started', turn }] : []
    }
    case 'turn/completed': {
      const turn = isRecord(params.turn) ? params.turn : {}
      return str(turn.id)
        ? [{ type: 'turn.ended', turn: str(turn.id), status: TURN_END[str(turn.status)] ?? 'done' }]
        : []
    }
    case 'item/started':
      return codexItem(params.item, str(params.turnId), 'started')
    case 'item/completed':
      return codexItem(params.item, str(params.turnId), 'completed')
    case 'item/agentMessage/delta':
      return str(params.delta)
        ? [
            {
              type: 'text',
              turn: str(params.turnId),
              id: str(params.itemId),
              text: str(params.delta),
              append: true,
            },
          ]
        : []
    case 'item/commandExecution/outputDelta':
      return str(params.delta)
        ? [
            {
              type: 'tool.result',
              turn: str(params.turnId),
              id: str(params.itemId),
              output: str(params.delta),
              append: true,
            },
          ]
        : []
    case 'turn/plan/updated':
      return planEvent(params)
    default:
      return []
  }
}

export function codexTurn(raw: unknown): StreamEvent[] {
  const turn = isRecord(raw) ? raw : null
  const id = turn ? str(turn.id) : ''
  if (!turn || !id) return []
  const events: StreamEvent[] = [{ type: 'turn.started', turn: id }]
  for (const item of Array.isArray(turn.items) ? turn.items : []) {
    events.push(...codexItem(item, id, 'completed'))
  }
  const status = str(turn.status)
  if (status !== 'inProgress') {
    events.push({ type: 'turn.ended', turn: id, status: TURN_END[status] ?? 'done' })
  }
  return events
}
