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
  type WikiError,
  type WikiScope,
  deletePage,
  getPage,
  listPages,
  searchPages,
  setPage,
  wikiPath,
} from './store'

interface WikiArgs {
  scope: WikiScope
  first?: string
  body?: string
  title?: string
}

function isError(r: unknown): r is WikiError {
  return typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === false
}

function readArgs(args: unknown, firstKey: 'slug' | 'q'): WikiArgs {
  const cli = cliArgs(args)
  if (cli) {
    const { bools, rest } = parseFlags(cli.argv, [], ['global'])
    return { scope: bools.has('global') ? 'global' : 'project', first: rest[0], body: cli.stdin }
  }
  const named = namedArgs(args)
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return {
    scope: named.scope === 'global' ? 'global' : 'project',
    first: str(named[firstKey]),
    body: str(named.body),
    title: str(named.title),
  }
}

function withPath(
  a: WikiArgs,
  caller: ExtensionCaller,
  write: boolean,
  fn: (path: string) => ExtensionResult,
): ExtensionResult {
  if (write && a.scope === 'global' && !caller.capabilities.includes('workspace-wide')) {
    return failure('needs-elevation', 'workspace-wide')
  }
  const path = wikiPath(a.scope, caller.workDir)
  return isError(path) ? path : fn(path)
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

  const handlers: Record<string, CommandHandler> = {
    get: (args, caller) => {
      const a = readArgs(args, 'slug')
      if (!a.first) return failure('invalid-args', 'get <slug> [--global]')
      return withPath(a, caller, false, (path) => {
        const page = getPage(path, a.first ?? '')
        return isError(page) ? page : ok(page.body, page)
      })
    },
    set: (args, caller) => {
      const a = readArgs(args, 'slug')
      if (!a.first) return failure('invalid-args', 'set <slug> [--global] (body on stdin)')
      return withPath(a, caller, true, (path) => {
        const res = setPage(path, a.first ?? '', a.body ?? '', a.title)
        if (isError(res)) return res
        panel.changed()
        return ok('ok')
      })
    },
    ls: (args, caller) => {
      const a = readArgs(args, 'slug')
      return withPath(a, caller, false, (path) => {
        const pages = listPages(path)
        return ok(pages.map((p) => `${p.slug}\t${p.title}\t${p.updatedAt}`).join('\n'), { pages })
      })
    },
    search: (args, caller) => {
      const a = readArgs(args, 'q')
      if (!a.first) return failure('invalid-args', 'search <q> [--global]')
      return withPath(a, caller, false, (path) => {
        const matches = searchPages(path, a.first ?? '')
        return ok(matches.map((m) => `${m.slug}\t${m.title}\t${m.snippet}`).join('\n'), { matches })
      })
    },
    rm: (args, caller) => {
      const a = readArgs(args, 'slug')
      if (!a.first) return failure('invalid-args', 'rm <slug> [--global]')
      return withPath(a, caller, true, (path) => {
        deletePage(path, a.first ?? '')
        panel.changed()
        return ok('ok')
      })
    },
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
