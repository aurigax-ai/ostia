import {
  type CommandHandler,
  type ExtensionCaller,
  type ExtensionResult,
  type Translate,
  failure,
  namedArgs,
  ok,
} from '@aurigax-ai/pine-extension-sdk'
import type { CliResult } from './cli'
import { type DaemonApi, daemonApi, readThread } from './daemon'
import type { TrellisService } from './service'
import {
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
} from './trellis'

export interface PanelDeps {
  service: TrellisService
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
