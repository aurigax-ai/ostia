/**
 * Command registry — the action spine (docs/ARCHITECTURE.md §5.11).
 *
 * Every user-facing action is a named command. In Phase 0 the only caller is
 * the UI itself; later phases add the command palette, keybindings, the `pine`
 * control CLI, agent skills, and the phone companion — all invoking THIS registry.
 * Designing it now keeps those callers from being bolt-ons.
 */

/** Context passed to every command (what is "current"). Grows over time. */
export interface CommandContext {
  /** The active session (sidebar entry) the panes belong to. */
  activeSessionId: string | null
  /** The focused pane within the active session's layout. */
  activePaneId: string | null
}

export interface CommandDef<Args = void> {
  id: string
  title: string
  /** Category for grouping in the palette. */
  category?: string
  /** Hide from the palette (e.g. commands that require explicit args from a caller). */
  hidden?: boolean
  run: (args: Args, ctx: CommandContext) => void | Promise<void>
}

// biome-ignore lint/suspicious/noExplicitAny: registry stores heterogeneous command arg types.
type AnyCommand = CommandDef<any>

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

  register<Args>(def: CommandDef<Args>): void {
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

  /** Execute a command by id. Throws if unknown. */
  async exec<Args>(id: string, args?: Args): Promise<void> {
    const cmd = this.commands.get(id)
    if (!cmd) throw new Error(`unknown command: ${id}`)
    await cmd.run(args, this.contextProvider())
  }
}

/** The app-wide singleton registry. */
export const commands = new CommandRegistry()
