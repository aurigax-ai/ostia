import {
  type AgentOfferOptions,
  type AgentOfferResult,
  type CommandHandler,
  type ExtensionCaller,
  type ExtensionResult,
  type OpenTerminalResult,
  type RunAgentOptions,
  type Translate,
  failure,
  namedArgs,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import type { CliResult } from './cli'
import { type DaemonApi, daemonApi, readThread } from './daemon'
import { reviewColumn, taskLabel, taskLine, taskPrompt } from './prompt'
import type { TrellisService } from './service'
import type { AgentTasks } from './tasks'
import {
  type CardDetail,
  HUMAN_ACTOR,
  type TrellisError,
  boardSlug,
  cardRef,
  cardTitle,
  columnName,
  entrySlug,
  longText,
  priority,
  projectKey,
  projectOfRef,
} from './trellis'

export interface AgentLauncher {
  list: () => Promise<string[]>
  run: (opts: RunAgentOptions) => Promise<OpenTerminalResult>
  offer: (opts: AgentOfferOptions) => Promise<AgentOfferResult>
  focus: (paneId: string) => Promise<ExtensionResult>
  mark: (paneId: string, card: CardDetail, locale: string | undefined) => void
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function agentArg(raw: unknown): string | null {
  return typeof raw === 'string' && AGENT_NAME.test(raw) ? raw : null
}

export interface PanelDeps {
  service: TrellisService
  agents: AgentLauncher
  tasks: AgentTasks
  confirm: (req: {
    title: string
    message: string
    detail?: string
    confirmLabel?: string
    cancelLabel?: string
  }) => Promise<boolean>
  translate: (locale: string | undefined) => Translate
  daemonCacheMs?: number
}

const DAEMON_CACHE_MS = 15_000

function errorResult(error: TrellisError): ExtensionResult {
  return failure(error.code, error.fix ? `${error.message}\n${error.fix}` : error.message)
}

function result<T>(res: CliResult<T>, data: (value: T) => unknown): ExtensionResult {
  return res.ok ? ok(undefined, data(res.value)) : errorResult(res.error)
}

function invalid(field: string): ExtensionResult {
  return failure('invalid-args', field)
}

export function panelHandlers(deps: PanelDeps): Record<string, CommandHandler> {
  const { service } = deps
  const cli = service.cli
  let daemon: { api: DaemonApi | null; at: number } | null = null

  const currentDaemon = async (): Promise<DaemonApi | null> => {
    const now = Date.now()
    if (daemon && now - daemon.at < (deps.daemonCacheMs ?? DAEMON_CACHE_MS)) return daemon.api
    const status = await cli.daemonStatus()
    const api = status.ok && status.value.running ? daemonApi(status.value.url) : null
    daemon = { api, at: now }
    return api
  }

  const wrote = <T>(res: CliResult<T>, data: (value: T) => unknown): ExtensionResult => {
    if (res.ok) service.changed()
    return result(res, data)
  }

  const refArg = (args: unknown): string | null => cardRef(namedArgs(args).ref)

  const taskCard = async (
    ref: string,
    board: string | undefined,
  ): Promise<{ card: CardDetail; review: string | null } | ExtensionResult> => {
    const detail = await cli.card(ref)
    if (!detail.ok) return errorResult(detail.error)
    const project = projectOfRef(ref)
    const shown = project ? await cli.board({ project, board }) : null
    const review = shown?.ok ? reviewColumn(shown.value.columns.map((c) => c.name)) : null
    return { card: detail.value, review }
  }

  const track = (
    card: CardDetail,
    paneId: string,
    agent: string | null,
    locale: string | undefined,
  ): void => {
    deps.tasks.set({ ref: card.ref, paneId, agent, at: Date.now() })
    deps.agents.mark(paneId, card, locale)
    service.changed()
  }

  const taskArgs = (
    args: unknown,
    caller: ExtensionCaller,
  ): { ref: string; board: string | undefined; workspaceId: string } | ExtensionResult => {
    const named = namedArgs(args)
    const ref = refArg(args)
    const board = named.board === undefined ? undefined : boardSlug(named.board)
    if (!ref) return invalid('ref')
    if (board === null) return invalid('board')
    if (!caller.workspaceId) {
      return failure('no-workspace', deps.translate(caller.locale)('task.noWorkspace'))
    }
    return { ref, board, workspaceId: caller.workspaceId }
  }

  return {
    context: async (_args, caller) => {
      if (!(await cli.isInstalled())) {
        return failure('not-installed', deps.translate(caller.locale)('notInstalled'))
      }
      const projects = await cli.projects()
      if (!projects.ok) return errorResult(projects.error)
      const own = service.projectFor(caller.workDir)
      return ok(undefined, {
        actor: HUMAN_ACTOR,
        workspace: own ? { project: own.project, board: own.board ?? null } : null,
        canInit: Boolean(caller.workDir) && !own,
        projects: projects.value,
      })
    },
    board: async (args) => {
      const named = namedArgs(args)
      const project = projectKey(named.project)
      if (!project) return invalid('project')
      const board =
        named.board === undefined || named.board === null ? undefined : boardSlug(named.board)
      if (board === null) return invalid('board')
      const [shown, boards] = await Promise.all([
        cli.board({ project, board }),
        cli.boards(project),
      ])
      if (!shown.ok) return errorResult(shown.error)
      return ok(undefined, { board: shown.value, boards: boards.ok ? boards.value : [] })
    },
    card: async (args) => {
      const ref = refArg(args)
      if (!ref) return invalid('ref')
      const board = boardSlug(namedArgs(args).board)
      const detail = await cli.card(ref)
      if (!detail.ok) return errorResult(detail.error)
      const api = board ? await currentDaemon() : null
      const project = ref.slice(0, ref.lastIndexOf('-'))
      const thread = api && board ? await readThread(api, project, board, ref) : null
      return ok(undefined, { card: detail.value, thread })
    },
    move: async (args) => {
      const ref = refArg(args)
      const column = columnName(namedArgs(args).column)
      if (!ref) return invalid('ref')
      if (!column) return invalid('column')
      return wrote(await cli.move(ref, column), (card) => ({ card }))
    },
    comment: async (args) => {
      const ref = refArg(args)
      const body = longText(namedArgs(args).body)
      if (!ref) return invalid('ref')
      if (!body?.trim()) return invalid('body')
      return wrote(await cli.comment(ref, body), () => ({ ref }))
    },
    claim: async (args) => {
      const ref = refArg(args)
      if (!ref) return invalid('ref')
      return wrote(await cli.claim(ref), (card) => ({ card }))
    },
    renew: async (args) => {
      const ref = refArg(args)
      if (!ref) return invalid('ref')
      return wrote(await cli.renew(ref), () => ({ ref }))
    },
    release: async (args) => {
      const ref = refArg(args)
      if (!ref) return invalid('ref')
      return wrote(await cli.release(ref), () => ({ ref }))
    },
    create: async (args) => {
      const named = namedArgs(args)
      const project = projectKey(named.project)
      const board = named.board === undefined ? undefined : boardSlug(named.board)
      const title = cardTitle(named.title)
      const body = named.body === undefined ? '' : longText(named.body)
      const column = named.column === undefined ? undefined : columnName(named.column)
      const level = named.priority === undefined ? undefined : priority(named.priority)
      if (!project) return invalid('project')
      if (board === null) return invalid('board')
      if (!title) return invalid('title')
      if (body === null) return invalid('body')
      if (column === null) return invalid('column')
      if (level === null) return invalid('priority')
      const res = await cli.newCard({
        project,
        board,
        title,
        body,
        column,
        priority: level,
      })
      return wrote(res, (card) => ({ card }))
    },
    vault: async (args) => {
      const project = projectKey(namedArgs(args).project)
      if (!project) return invalid('project')
      return result(await cli.vaultList(project), (entries) => ({ entries }))
    },
    entry: async (args) => {
      const named = namedArgs(args)
      const project = projectKey(named.project)
      const slug = entrySlug(named.slug)
      if (!project) return invalid('project')
      if (!slug) return invalid('slug')
      return result(await cli.vaultEntry(project, slug), (entry) => ({ entry }))
    },
    init: async (_args, caller) => initHere(deps, caller),
    agents: async () => ok(undefined, { agents: await deps.agents.list() }),
    tasks: async () =>
      ok(undefined, {
        tasks: deps.tasks.list().map(({ ref, agent, at }) => ({ ref, agent, at })),
      }),
    start: async (args, caller) => {
      const target = taskArgs(args, caller)
      if ('ok' in target) return target
      const agent = agentArg(namedArgs(args).agent)
      if (!agent) return invalid('agent')
      const found = await taskCard(target.ref, target.board)
      if ('ok' in found) return found
      const t = deps.translate(caller.locale)
      const res = await deps.agents.run({
        workspaceId: target.workspaceId,
        agent,
        prompt: taskPrompt(found.card, found.review, t),
      })
      if (!res.ok) return failure(res.error, res.message)
      track(found.card, res.paneId, agent, caller.locale)
      return ok(undefined, { ref: target.ref, agent })
    },
    offer: async (args, caller) => {
      const target = taskArgs(args, caller)
      if ('ok' in target) return target
      const found = await taskCard(target.ref, target.board)
      if ('ok' in found) return found
      const t = deps.translate(caller.locale)
      const res = await deps.agents.offer({
        workspaceId: target.workspaceId,
        text: taskLine(found.card, found.review, t),
        label: taskLabel(found.card),
      })
      if (!res.ok) return failure(res.error, res.message)
      if (!res.sent) return ok(undefined, { ref: target.ref, sent: false })
      track(found.card, res.paneId, null, caller.locale)
      return ok(undefined, { ref: target.ref, sent: true })
    },
    focus: async (args, caller) => {
      const ref = refArg(args)
      if (!ref) return invalid('ref')
      const t = deps.translate(caller.locale)
      const task = deps.tasks.get(ref)
      if (!task) return failure('no-task', t('task.none'))
      const res = await deps.agents.focus(task.paneId)
      if (res.ok) return ok()
      deps.tasks.dropPane(task.paneId)
      service.changed()
      return failure('pane-closed', t('task.gone'))
    },
  }
}

export async function initHere(deps: PanelDeps, caller: ExtensionCaller): Promise<ExtensionResult> {
  const t = deps.translate(caller.locale)
  const dir = caller.cwd ?? caller.workDir
  if (!dir) return failure('no-dir', t('noDir'))
  if (!(await deps.service.isInstalled())) return failure('not-installed', t('notInstalled'))
  const confirmed = await deps.confirm({
    title: t('initTitle'),
    message: t('initMessage', { dir }),
    detail: t('initDetail'),
    confirmLabel: t('initConfirm'),
    cancelLabel: t('cancel'),
  })
  if (!confirmed) return failure('cancelled', t('initCancelled'))
  const res = await deps.service.init(dir)
  return res.ok ? ok(res.text) : failure('init-failed', res.message)
}
