import {
  type CommandHandler,
  type ExtensionCaller,
  type ExtensionResult,
  cliArgs,
  connect,
  failure,
  namedArgs,
  ok,
  parseFlags,
  startPanelServer,
} from '../sdk'
import {
  type BoardError,
  addCard,
  boardPath,
  formatBoard,
  loadBoard,
  removeCard,
  sanitizePatch,
  updateCard,
} from './board'

const NO_WORKDIR = failure(
  'no-project-workdir',
  "no project workDir is known for this session yet, so a project-scoped board would collapse into a shared default — retry once the pane's project is resolved.",
)

function withBoard(
  caller: ExtensionCaller,
  fn: (path: string) => ExtensionResult,
): ExtensionResult {
  const workDir = caller.workDir?.trim()
  if (!workDir) return NO_WORKDIR
  return fn(boardPath(workDir))
}

function isError(r: unknown): r is BoardError {
  return typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === false
}

function positional(args: unknown, names: string[]): Record<string, string | undefined> {
  const cli = cliArgs(args)
  const named = namedArgs(args)
  const out: Record<string, string | undefined> = {}
  names.forEach((name, i) => {
    const value = cli ? cli.argv[i] : named[name]
    out[name] = typeof value === 'string' && value ? value : undefined
  })
  return out
}

function mutation(
  onChange: () => void,
  run: (path: string, args: unknown) => { ok: true } | BoardError,
  usage: string,
  required: (args: unknown) => boolean,
): CommandHandler {
  return (args, caller) => {
    if (!required(args)) return failure('invalid-args', usage)
    return withBoard(caller, (path) => {
      const res = run(path, args)
      if (isError(res)) return res
      onChange()
      return ok('ok')
    })
  }
}

async function main(): Promise<void> {
  const ext = await connect()
  const panel = await startPanelServer({
    dir: __dirname,
    files: ['panel.html', 'panel.js', 'panel.css', 'base.css'],
    handle: async (command, args, caller) => {
      const handler = handlers[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  const changed = (): void => panel.changed()

  const cardAndColumn = (args: unknown) => positional(args, ['cardId', 'column'])
  const cardOnly = (args: unknown) => positional(args, ['cardId'])

  const handlers: Record<string, CommandHandler> = {
    get: (_args, caller) => withBoard(caller, (path) => ok(undefined, loadBoard(path))),
    ls: (_args, caller) =>
      withBoard(caller, (path) => {
        const board = loadBoard(path)
        return ok(formatBoard(board), board)
      }),
    add: (args, caller) => {
      const cli = cliArgs(args)
      let input: { title: string; column?: string; body?: string }
      if (cli) {
        const { flags, rest } = parseFlags(cli.argv, ['column', 'body'])
        input = {
          title: rest[0] ?? '',
          column: flags.column || undefined,
          body: flags.body || undefined,
        }
      } else {
        const named = namedArgs(args)
        input = {
          title: typeof named.title === 'string' ? named.title : '',
          column: typeof named.column === 'string' ? named.column : undefined,
          body: typeof named.body === 'string' ? named.body : undefined,
        }
      }
      if (!input.title.trim())
        return failure('invalid-args', 'add "<title>" [--column X] [--body ...]')
      return withBoard(caller, (path) => {
        const res = addCard(path, input)
        if (isError(res)) return res
        changed()
        return ok(JSON.stringify(res.card), res.card)
      })
    },
    move: mutation(
      changed,
      (path, args) => {
        const { cardId, column } = cardAndColumn(args)
        return updateCard(path, cardId ?? '', { column })
      },
      'move <id> <column>',
      (args) => Boolean(cardAndColumn(args).cardId && cardAndColumn(args).column),
    ),
    assign: mutation(
      changed,
      (path, args) => {
        const { cardId, assignee } = positional(args, ['cardId', 'assignee'])
        return updateCard(path, cardId ?? '', { assignee })
      },
      'assign <id> <who>',
      (args) => {
        const p = positional(args, ['cardId', 'assignee'])
        return Boolean(p.cardId && p.assignee)
      },
    ),
    done: mutation(
      changed,
      (path, args) => updateCard(path, cardOnly(args).cardId ?? '', { column: 'done' }),
      'done <id>',
      (args) => Boolean(cardOnly(args).cardId),
    ),
    rm: mutation(
      changed,
      (path, args) => removeCard(path, cardOnly(args).cardId ?? ''),
      'rm <id>',
      (args) => Boolean(cardOnly(args).cardId),
    ),
    update: mutation(
      changed,
      (path, args) => {
        const named = namedArgs(args)
        return updateCard(path, String(named.cardId), sanitizePatch(named.patch))
      },
      'update {cardId, patch}',
      (args) => typeof namedArgs(args).cardId === 'string',
    ),
    open: async (_args, caller) => {
      await ext.openPanel(caller.sessionId)
      return ok('ok')
    },
  }

  ext.onPanel((caller) => ({
    url: panel.url({
      workDir: caller.workDir ?? '',
      sessionId: caller.sessionId ?? '',
      locale: caller.locale ?? 'en',
    }),
  }))
  await ext.registerCommands(handlers)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
