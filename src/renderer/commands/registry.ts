/**
 * Command registry — the action spine (docs/ARCHITECTURE.md §5.11).
 *
 * Every user-facing action is a named command. In Phase 0 the only caller is
 * the UI itself; later phases add the command palette, keybindings, the `pine`
 * control CLI, agent skills, and the phone companion — all invoking THIS registry.
 * Designing it now keeps those callers from being bolt-ons.
 */

import type { Capability } from '../../shared/capabilities'
import { DEFAULT_CAPABILITIES } from '../../shared/capabilities'

/** Minimal JSON-Schema stand-in (no validator dep yet; shape is opaque here). */
export type JSONSchema = Record<string, unknown>

/** How a command resolves the pane it acts on. */
export type TargetMode = 'active' | 'explicit' | 'none'

/** Uniform result of executing a command (what the socket/CLI return). */
export interface CommandResult<R = unknown> {
  ok: boolean
  result?: R
  error?: { code: string; message: string }
}

/** Context passed to every command (what is "current"). Grows over time. */
export interface CommandContext {
  /** The active session (sidebar entry) the panes belong to. */
  activeSessionId: string | null
  /** The focused pane within the active session's layout. */
  activePaneId: string | null
  /**
   * Explicit target for non-UI callers (CLI / bridge). When present, a
   * command with target:'explicit' acts on this instead of the active session.
   * Wired by the command bridge in Slice 6.
   */
  target?: { windowId?: string; sessionId: string; paneId: string | null } | null
}

export interface CommandDef<Args = void, R = void> {
  id: string
  title: string
  /** Category for grouping in the palette. */
  category?: string
  /** Hide from the palette (e.g. commands that require explicit args from a caller). */
  hidden?: boolean
  /** JSON Schema for args — powers `pine commands --json` + validation. */
  argsSchema?: JSONSchema
  /** JSON Schema for the result. */
  resultSchema?: JSONSchema
  /** Capabilities a caller must hold. Defaults to DEFAULT_CAPABILITIES. */
  capabilities?: Capability[]
  /** How the command resolves its target pane. Defaults to 'active'. */
  target?: TargetMode
  run: (args: Args, ctx: CommandContext) => R | Promise<R>
}

// biome-ignore lint/suspicious/noExplicitAny: registry stores heterogeneous command arg/result types.
type AnyCommand = CommandDef<any, any>

/** Serialized, stable view of a command for external discovery. */
export interface CommandDescriptor {
  id: string
  title: string
  category?: string
  hidden: boolean
  argsSchema: JSONSchema | null
  resultSchema: JSONSchema | null
  capabilities: Capability[]
  target: TargetMode
}

export class CommandRegistry {
  private commands = new Map<string, AnyCommand>()
  private contextProvider: () => CommandContext = () => ({
    activeSessionId: null,
    activePaneId: null,
  })

  /** Wire up how the registry learns the current context. */
  setContextProvider(provider: () => CommandContext): void {
    this.contextProvider = provider
  }

  register<Args, R = void>(def: CommandDef<Args, R>): void {
    if (this.commands.has(def.id)) {
      throw new Error(`command already registered: ${def.id}`)
    }
    this.commands.set(def.id, def as AnyCommand)
  }

  has(id: string): boolean {
    return this.commands.has(id)
  }

  list(): AnyCommand[] {
    return [...this.commands.values()]
  }

  /** Stable, sorted, defaults-applied serialization — the `pine commands --json` contract. */
  describe(): CommandDescriptor[] {
    return this.list()
      .map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        hidden: Boolean(c.hidden),
        argsSchema: c.argsSchema ?? null,
        resultSchema: c.resultSchema ?? null,
        capabilities: c.capabilities ?? DEFAULT_CAPABILITIES,
        target: c.target ?? 'active',
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Execute a command by id. Never throws — returns a uniform CommandResult so
   * the socket/CLI can map it to an exit status. UI callers may ignore the result.
   */
  async exec<Args, R = unknown>(id: string, args?: Args): Promise<CommandResult<R>> {
    const cmd = this.commands.get(id)
    if (!cmd) {
      return { ok: false, error: { code: 'unknown-command', message: `unknown command: ${id}` } }
    }
    try {
      const result = (await cmd.run(args, this.contextProvider())) as R
      return { ok: true, result }
    } catch (e) {
      return {
        ok: false,
        error: { code: 'command-failed', message: e instanceof Error ? e.message : String(e) },
      }
    }
  }
}

/** The app-wide singleton registry. */
export const commands = new CommandRegistry()
