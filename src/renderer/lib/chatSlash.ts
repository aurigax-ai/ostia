import {
  ArrowClockwiseIcon,
  ChatsIcon,
  CpuIcon,
  DownloadSimpleIcon,
  EraserIcon,
  type Icon,
  LightbulbIcon,
  NotePencilIcon,
  PaperclipIcon,
  PencilSimpleIcon,
  QuestionIcon,
  SparkleIcon,
  WrenchIcon,
} from '@phosphor-icons/react'

export type SlashId =
  | 'new'
  | 'clear'
  | 'sessions'
  | 'rename'
  | 'export'
  | 'retry'
  | 'explain'
  | 'attach'
  | 'tools'
  | 'skill'
  | 'model'
  | 'help'

export type SlashReason =
  | 'busy'
  | 'empty'
  | 'noAnswer'
  | 'notSaved'
  | 'noProvider'
  | 'noTools'
  | 'noSkills'
  | 'noSkillFolders'
  | 'skillsOff'
  | 'noSource'
  | 'needsTitle'
  | 'needsSkill'
  | 'unknownSkill'
  | 'unknownSession'
  | 'unknownSource'

export type SlashArgKind = 'title' | 'path' | 'skill' | 'session' | 'source'

export interface SlashChoice {
  value: string
  label: string
  detail?: string
}

export interface SlashContext {
  busy: boolean
  messageCount: number
  lastRole: string | null
  recording: boolean
  provider: boolean
  tools: boolean
  skillFolders: number
  skills: readonly { name: string; description: string }[]
  skillsOn: boolean
  sessions: readonly { id: string; title: string }[]
  sources: readonly SlashChoice[]
}

export interface SlashActions {
  newChat: () => void
  clear: () => void
  openSessions: () => void
  openSession: (id: string) => void
  rename: (title: string) => void
  exportMarkdown: () => void
  retry: () => void
  explain: (source: string) => void
  attach: (query: string) => void
  openTools: () => void
  applySkill: (name: string, task: string) => void
  showModel: () => void
  showHelp: () => void
}

export interface SlashArg {
  kind: SlashArgKind
  required: boolean
  choices?: (ctx: SlashContext) => SlashChoice[]
  firstWord?: boolean
  askWhenSeveral?: boolean
}

export interface SlashCommand {
  id: SlashId
  icon: Icon
  arg?: SlashArg
  unavailable: (ctx: SlashContext) => SlashReason | null
  run: (actions: SlashActions, arg: string, ctx: SlashContext) => SlashReason | null
}

function firstOf(...reasons: (SlashReason | false)[]): SlashReason | null {
  return reasons.find((r): r is SlashReason => r !== false) ?? null
}

function matchChoice(choices: readonly SlashChoice[], typed: string): SlashChoice | undefined {
  const wanted = typed.trim().toLowerCase()
  return (
    choices.find((c) => c.value.toLowerCase() === wanted) ??
    choices.find((c) => c.label.toLowerCase() === wanted) ??
    choices.find((c) => c.label.toLowerCase().startsWith(wanted))
  )
}

function sessionChoices(ctx: SlashContext): SlashChoice[] {
  return ctx.sessions.map((s) => ({ value: s.id, label: s.title }))
}

function skillChoices(ctx: SlashContext): SlashChoice[] {
  return ctx.skills.map((s) => ({ value: s.name, label: s.name, detail: s.description }))
}

function skillReason(ctx: SlashContext): SlashReason | null {
  return firstOf(
    !ctx.provider && 'noProvider',
    !ctx.tools && 'noTools',
    ctx.skills.length === 0 && (ctx.skillFolders > 0 ? 'noSkills' : 'noSkillFolders'),
    !ctx.skillsOn && 'skillsOff',
    ctx.busy && 'busy',
  )
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'new',
    icon: NotePencilIcon,
    unavailable: (ctx) => firstOf(ctx.busy && 'busy'),
    run: (actions) => {
      actions.newChat()
      return null
    },
  },
  {
    id: 'clear',
    icon: EraserIcon,
    unavailable: (ctx) => firstOf(ctx.busy && 'busy', ctx.messageCount === 0 && 'empty'),
    run: (actions) => {
      actions.clear()
      return null
    },
  },
  {
    id: 'sessions',
    icon: ChatsIcon,
    arg: { kind: 'session', required: false, choices: sessionChoices },
    unavailable: () => null,
    run: (actions, arg, ctx) => {
      if (!arg.trim()) {
        actions.openSessions()
        return null
      }
      const found = matchChoice(sessionChoices(ctx), arg)
      if (!found) return 'unknownSession'
      actions.openSession(found.value)
      return null
    },
  },
  {
    id: 'rename',
    icon: PencilSimpleIcon,
    arg: { kind: 'title', required: true },
    unavailable: () => null,
    run: (actions, arg) => {
      const title = arg.trim()
      if (!title) return 'needsTitle'
      actions.rename(title)
      return null
    },
  },
  {
    id: 'export',
    icon: DownloadSimpleIcon,
    unavailable: (ctx) =>
      firstOf(!ctx.recording && 'notSaved', ctx.messageCount === 0 && 'empty', ctx.busy && 'busy'),
    run: (actions) => {
      actions.exportMarkdown()
      return null
    },
  },
  {
    id: 'retry',
    icon: ArrowClockwiseIcon,
    unavailable: (ctx) =>
      firstOf(
        !ctx.provider && 'noProvider',
        ctx.busy && 'busy',
        ctx.lastRole !== 'assistant' && 'noAnswer',
      ),
    run: (actions) => {
      actions.retry()
      return null
    },
  },
  {
    id: 'explain',
    icon: LightbulbIcon,
    arg: {
      kind: 'source',
      required: false,
      askWhenSeveral: true,
      choices: (ctx) => [...ctx.sources],
    },
    unavailable: (ctx) =>
      firstOf(
        !ctx.provider && 'noProvider',
        ctx.busy && 'busy',
        ctx.sources.length === 0 && 'noSource',
      ),
    run: (actions, arg, ctx) => {
      const source = arg.trim() ? matchChoice(ctx.sources, arg) : ctx.sources[0]
      if (!source) return 'unknownSource'
      actions.explain(source.value)
      return null
    },
  },
  {
    id: 'attach',
    icon: PaperclipIcon,
    arg: { kind: 'path', required: false },
    unavailable: () => null,
    run: (actions, arg) => {
      actions.attach(arg.trim())
      return null
    },
  },
  {
    id: 'tools',
    icon: WrenchIcon,
    unavailable: (ctx) => firstOf(!ctx.provider && 'noProvider', !ctx.tools && 'noTools'),
    run: (actions) => {
      actions.openTools()
      return null
    },
  },
  {
    id: 'skill',
    icon: SparkleIcon,
    arg: { kind: 'skill', required: true, firstWord: true, choices: skillChoices },
    unavailable: skillReason,
    run: (actions, arg, ctx) => {
      const [name = '', ...rest] = arg.trim().split(/\s+/)
      if (!name) return 'needsSkill'
      const skill = ctx.skills.find((s) => s.name.toLowerCase() === name.toLowerCase())
      if (!skill) return 'unknownSkill'
      actions.applySkill(skill.name, rest.join(' '))
      return null
    },
  },
  {
    id: 'model',
    icon: CpuIcon,
    unavailable: () => null,
    run: (actions) => {
      actions.showModel()
      return null
    },
  },
  {
    id: 'help',
    icon: QuestionIcon,
    unavailable: () => null,
    run: (actions) => {
      actions.showHelp()
      return null
    },
  },
]

export interface ParsedSlash {
  name: string
  arg: string
  spaced: boolean
}

const SLASH_DRAFT = /^\s*\/(\S*)(?:(\s+)([\s\S]*))?$/

export function parseSlash(draft: string): ParsedSlash | null {
  const match = SLASH_DRAFT.exec(draft)
  if (!match) return null
  return { name: match[1], arg: match[3] ?? '', spaced: match[2] !== undefined }
}

export function slashIndex(draft: string): number {
  return draft.indexOf('/')
}

export function findSlashCommand(name: string): SlashCommand | undefined {
  const id = name.toLowerCase()
  return SLASH_COMMANDS.find((c) => c.id === id)
}

export function filterSlashCommands(
  query: string,
  titleOf: (id: SlashId) => string = () => '',
): SlashCommand[] {
  const q = query.toLowerCase()
  if (!q) return [...SLASH_COMMANDS]
  const starts = SLASH_COMMANDS.filter((c) => c.id.startsWith(q))
  const inside = SLASH_COMMANDS.filter(
    (c) => !starts.includes(c) && (c.id.includes(q) || titleOf(c.id).toLowerCase().includes(q)),
  )
  return [...starts, ...inside]
}

export function filterChoices(choices: readonly SlashChoice[], query: string): SlashChoice[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...choices]
  const starts = choices.filter((c) => c.label.toLowerCase().startsWith(q))
  const inside = choices.filter((c) => !starts.includes(c) && c.label.toLowerCase().includes(q))
  return [...starts, ...inside]
}

export type SlashMenu =
  | { phase: 'command'; query: string; commands: SlashCommand[] }
  | { phase: 'arg'; command: SlashCommand; query: string; choices: SlashChoice[] }

export function slashMenu(
  draft: string,
  ctx: SlashContext,
  titleOf?: (id: SlashId) => string,
): SlashMenu | null {
  const parsed = parseSlash(draft)
  if (!parsed) return null
  if (!parsed.spaced) {
    const commands = filterSlashCommands(parsed.name, titleOf)
    return commands.length > 0 ? { phase: 'command', query: parsed.name, commands } : null
  }
  const command = findSlashCommand(parsed.name)
  const arg = command?.arg
  if (!command || !arg?.choices || command.unavailable(ctx)) return null
  if (arg.firstWord && /\s/.test(parsed.arg)) return null
  const choices = filterChoices(arg.choices(ctx), parsed.arg)
  return choices.length > 0 ? { phase: 'arg', command, query: parsed.arg, choices } : null
}

export interface SlashRow {
  key: string
  command: SlashCommand
  choice?: SlashChoice
  reason: SlashReason | null
}

export function slashRows(menu: SlashMenu, ctx: SlashContext): SlashRow[] {
  if (menu.phase === 'command') {
    return menu.commands.map((command) => ({
      key: `/${command.id}`,
      command,
      reason: command.unavailable(ctx),
    }))
  }
  return menu.choices.map((choice) => ({
    key: `/${menu.command.id} ${choice.value}`,
    command: menu.command,
    choice,
    reason: null,
  }))
}

export function stepRow(rows: readonly SlashRow[], key: string | undefined, step: 1 | -1): string {
  const at = rows.findIndex((r) => r.key === key)
  const next = (at + step + rows.length) % rows.length
  return rows[at === -1 && step === -1 ? rows.length - 1 : next]?.key ?? ''
}

export function activeRow(rows: readonly SlashRow[], key: string | null): SlashRow | undefined {
  return rows.find((r) => r.key === key) ?? rows.find((r) => !r.reason) ?? rows[0]
}

export type SlashPick = { kind: 'fill'; draft: string } | { kind: 'run'; draft: string }

export function pickCommand(command: SlashCommand, ctx: SlashContext, tab: boolean): SlashPick {
  const arg = command.arg
  if (!arg) return { kind: tab ? 'fill' : 'run', draft: `/${command.id}` }
  const several = arg.askWhenSeveral === true && (arg.choices?.(ctx).length ?? 0) > 1
  if (tab || arg.required || several) return { kind: 'fill', draft: `/${command.id} ` }
  return { kind: 'run', draft: `/${command.id}` }
}

export function pickChoice(command: SlashCommand, choice: SlashChoice): SlashPick {
  if (command.arg?.firstWord) return { kind: 'fill', draft: `/${command.id} ${choice.value} ` }
  return { kind: 'run', draft: `/${command.id} ${choice.value}` }
}

export type SlashOutcome =
  | { id: SlashId; ran: true }
  | { id: SlashId; ran: false; reason: SlashReason }

export function runSlash(
  draft: string,
  ctx: SlashContext,
  actions: SlashActions,
): SlashOutcome | null {
  const parsed = parseSlash(draft)
  const command = parsed ? findSlashCommand(parsed.name) : undefined
  if (!parsed || !command) return null
  const blocked = command.unavailable(ctx)
  if (blocked) return { id: command.id, ran: false, reason: blocked }
  const reason = command.run(actions, parsed.arg, ctx)
  return reason ? { id: command.id, ran: false, reason } : { id: command.id, ran: true }
}
