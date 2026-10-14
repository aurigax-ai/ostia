import { type AgentHookEvent, isAgentHookEvent, isHookAgent } from '../../shared/agentPlugins'
import type { ExtensionCaller } from '../../shared/extensions'
import { type ActivityEvent, parseHookEvent } from './hookEvent'
import type { Journal } from './journal'

const RECORDED_EVENTS: readonly AgentHookEvent[] = ['UserPromptSubmit', 'PreToolUse', 'Stop']
const MEMORY_ONLY_KINDS: readonly string[] = ['scratch']

export interface RecorderDeps {
  journal: Journal
  now: () => number
  redact: (texts: string[]) => Promise<string[] | null>
  workspaceKind: (workspaceId: string) => Promise<string | null>
  changed: () => void
}

export function keepsOnDisk(caller: ExtensionCaller, kind: string | null): boolean {
  return caller.sandboxed !== true && kind !== null && !MEMORY_ONLY_KINDS.includes(kind)
}

export class Recorder {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: RecorderDeps) {}

  accept(argv: readonly string[], stdin: string, caller: ExtensionCaller): boolean {
    const [agent, event] = argv
    if (!isHookAgent(agent) || !isAgentHookEvent(event) || !RECORDED_EVENTS.includes(event)) {
      return false
    }
    if (caller.kind !== 'pane' || !caller.paneId || !caller.workspaceId) return false
    const parsed = parseHookEvent(
      { agent, event, pane: caller.paneId, now: this.deps.now() },
      stdin,
    )
    if (!parsed) return false
    const workspaceId = caller.workspaceId
    this.queue = this.queue.then(() => this.store(workspaceId, parsed, caller)).catch(() => {})
    return true
  }

  settled(): Promise<void> {
    return this.queue
  }

  private async store(
    workspaceId: string,
    event: ActivityEvent,
    caller: ExtensionCaller,
  ): Promise<void> {
    const safe = await this.redacted(event)
    const kind = await this.deps.workspaceKind(workspaceId).catch(() => null)
    this.deps.journal.append(workspaceId, safe, keepsOnDisk(caller, kind))
    this.deps.changed()
  }

  private async redacted(event: ActivityEvent): Promise<ActivityEvent> {
    if (event.text === undefined) return event
    const { text, ...withoutText } = event
    const texts = await this.deps.redact([text]).catch(() => null)
    const clean = texts?.[0]
    return clean ? { ...withoutText, text: clean } : withoutText
  }
}
