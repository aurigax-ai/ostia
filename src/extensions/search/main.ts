import {
  type CommandHandler,
  type ExtensionCaller,
  type ExtensionResult,
  type OstiaExtension,
  cliArgs,
  connect,
  failure,
  namedArgs,
  ok,
  startPanelServer,
} from '../sdk'
import { parseFilesArgs, parseFindArgs } from './args'
import { rankFiles } from './fuzzy'
import { type FileList, type RgOutcome, listFiles, searchText } from './rg'
import {
  QUERY_MAX,
  agentRoot,
  formatMatches,
  insideRoot,
  panelQuery,
  panelRoot,
  rgFailure,
} from './scope'

const FILE_LIST_TTL_MS = 10_000
const PANEL_NAME_LIMIT = 50

class FileLists {
  private lists = new Map<string, { at: number; list: Promise<RgOutcome<FileList>> }>()

  get(root: string): Promise<RgOutcome<FileList>> {
    const cached = this.lists.get(root)
    if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached.list
    const list = listFiles(root)
    this.lists.set(root, { at: Date.now(), list })
    void list.then((res) => {
      if (!res.ok && this.lists.get(root)?.list === list) this.lists.delete(root)
    })
    return list
  }
}

class Searches {
  private running = new Map<string, AbortController>()

  start(key: string): AbortSignal {
    this.running.get(key)?.abort()
    const controller = new AbortController()
    this.running.set(key, controller)
    return controller.signal
  }

  finish(key: string, signal: AbortSignal): void {
    const current = this.running.get(key)
    if (current?.signal === signal) this.running.delete(key)
  }
}

class SearchExtension {
  private files = new FileLists()
  private searches = new Searches()

  constructor(private readonly ext: OstiaExtension) {}

  private async openPanel(caller: ExtensionCaller, path: string): Promise<ExtensionResult> {
    await this.ext.openPanel(caller.workspaceId, path)
    return ok()
  }

  handlers(): Record<string, CommandHandler> {
    return {
      find: async (args, caller) => {
        const cli = cliArgs(args)
        if (!cli) return this.openPanel(caller, '/')
        const parsed = parseFindArgs(cli.argv)
        if (typeof parsed === 'string') return failure('usage', parsed)
        const root = agentRoot(caller)
        if (typeof root !== 'string') return root
        const res = await searchText(root, parsed.query)
        if (!res.ok) return rgFailure(res)
        const data = { root, ...res.value }
        return parsed.json ? ok(JSON.stringify(data), data) : ok(formatMatches(res.value), data)
      },
      files: async (args, caller) => {
        const cli = cliArgs(args)
        if (!cli) return this.openPanel(caller, '/files')
        const parsed = parseFilesArgs(cli.argv)
        if (typeof parsed === 'string') return failure('usage', parsed)
        const root = agentRoot(caller)
        if (typeof root !== 'string') return root
        const list = await this.files.get(root)
        if (!list.ok) return rgFailure(list)
        const hits = rankFiles(parsed.query, list.value.paths, parsed.limit)
        const data = { root, files: hits.map((h) => h.path) }
        if (parsed.json) return ok(JSON.stringify(data), data)
        return ok(hits.length ? data.files.join('\n') : 'No files match', data)
      },
    }
  }

  panelHandlers(): Record<string, CommandHandler> {
    return {
      text: async (args, caller) => {
        const root = panelRoot(caller)
        if (!root) return failure('no-folder')
        const query = panelQuery(args)
        if (!query) return failure('invalid-args')
        const key = `text:${caller.workspaceId ?? root}`
        const signal = this.searches.start(key)
        const res = await searchText(root, query, signal)
        this.searches.finish(key, signal)
        return res.ok ? ok(undefined, { root, ...res.value }) : rgFailure(res)
      },
      names: async (args, caller) => {
        const root = panelRoot(caller)
        if (!root) return failure('no-folder')
        const query = namedArgs(args).query
        if (typeof query !== 'string' || query.length > QUERY_MAX) return failure('invalid-args')
        const list = await this.files.get(root)
        if (!list.ok) return rgFailure(list)
        const hits = rankFiles(query, list.value.paths, PANEL_NAME_LIMIT)
        return ok(undefined, { root, hits, truncated: list.value.truncated })
      },
      open: async (args, caller) => {
        const root = panelRoot(caller)
        if (!root || !caller.workspaceId) return failure('no-folder')
        const a = namedArgs(args)
        const path = insideRoot(root, a.path)
        if (!path) return failure('invalid-args', 'path must be inside the workspace folder')
        return this.ext.openFile({
          workspaceId: caller.workspaceId,
          path,
          ...(typeof a.line === 'number' ? { line: a.line } : {}),
          ...(typeof a.column === 'number' ? { column: a.column } : {}),
        })
      },
    }
  }
}

async function main(): Promise<void> {
  const ext = await connect()
  const search = new SearchExtension(ext)
  const handlers = search.handlers()
  const panelOnly = search.panelHandlers()
  const panel = await startPanelServer({
    dir: __dirname,
    files: ['panel.html', 'panel.js', 'panel.css', 'base.css'],
    handle: async (command, args, caller) => {
      const handler = panelOnly[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  ext.onPanel((caller, path) => {
    const url = new URL(path ?? '/', 'http://panel')
    return {
      url: panel.url({
        workDir: caller.workDir ?? '',
        workspaceId: caller.workspaceId ?? '',
        locale: caller.locale ?? 'en',
        mode: url.pathname === '/files' ? 'files' : 'text',
      }),
    }
  })
  await ext.registerCommands(handlers)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
