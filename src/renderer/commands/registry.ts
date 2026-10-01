import type { Capability } from '../../shared/capabilities'
import { DEFAULT_CAPABILITIES } from '../../shared/capabilities'
import type { CommandDescriptor, CommandResult, JSONSchema, TargetMode } from '../../shared/types'

export type {
  CommandResult,
  CommandError,
  CommandErrorCode,
  CommandDescriptor,
  TargetMode,
  JSONSchema,
} from '../../shared/types'

export interface CommandContext {
  activeWorkspaceId: string | null
  activePaneId: string | null
  target?: { windowId?: string; workspaceId: string; paneId: string | null } | null
}

export interface CommandChoice {
  value: string
  label: string
  disabledReason?: string
}

export interface CommandDef<Args = void, R = void> {
  id: string
  title: string
  category?: string
  hidden?: boolean
  local?: boolean
  argument?: string
  choices?: () => Promise<CommandChoice[]>
  emptyChoices?: () => string
  argsSchema?: JSONSchema
  resultSchema?: JSONSchema
  capabilities?: Capability[]
  target?: TargetMode
  run: (args: Args, ctx: CommandContext) => R | Promise<R>
}

// biome-ignore lint/suspicious/noExplicitAny: registry stores heterogeneous command arg/result types.
type AnyCommand = CommandDef<any, any>

export class CommandRegistry {
  private commands = new Map<string, AnyCommand>()
  private listeners = new Set<() => void>()
  private revision = 0
  private contextProvider: () => CommandContext = () => ({
    activeWorkspaceId: null,
    activePaneId: null,
  })

  setContextProvider(provider: () => CommandContext): void {
    this.contextProvider = provider
  }

  register<Args, R = void>(def: CommandDef<Args, R>): void {
    if (this.commands.has(def.id)) {
      throw new Error(`command already registered: ${def.id}`)
    }
    this.commands.set(def.id, def as AnyCommand)
    this.notify()
  }

  unregister(id: string): void {
    if (this.commands.delete(id)) this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  version(): number {
    return this.revision
  }

  private notify(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  has(id: string): boolean {
    return this.commands.has(id)
  }

  list(): AnyCommand[] {
    return [...this.commands.values()]
  }

  isLocal(id: string): boolean {
    return Boolean(this.commands.get(id)?.local)
  }

  describe(): CommandDescriptor[] {
    return this.list()
      .filter((c) => !c.local)
      .map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category ?? null,
        hidden: Boolean(c.hidden),
        argsSchema: c.argsSchema ?? null,
        resultSchema: c.resultSchema ?? null,
        capabilities: c.capabilities ?? DEFAULT_CAPABILITIES,
        target: c.target ?? 'active',
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async execWith<Args, R = unknown>(
    ctx: CommandContext,
    id: string,
    args?: Args,
  ): Promise<CommandResult<R>> {
    const cmd = this.commands.get(id)
    if (!cmd) {
      return { ok: false, error: { code: 'unknown-command', message: `unknown command: ${id}` } }
    }
    try {
      const result = (await cmd.run(args, ctx)) as R
      return { ok: true, result }
    } catch (e) {
      return {
        ok: false,
        error: { code: 'command-failed', message: e instanceof Error ? e.message : String(e) },
      }
    }
  }

  exec<Args, R = unknown>(id: string, args?: Args): Promise<CommandResult<R>> {
    return this.execWith(this.contextProvider(), id, args)
  }
}

export const commands = new CommandRegistry()
