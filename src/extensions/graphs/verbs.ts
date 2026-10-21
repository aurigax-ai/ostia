import { isAbsolute, resolve } from 'node:path'
import {
  type CommandHandler,
  cliArgs,
  type ExtensionCaller,
  type ExtensionResult,
  failure,
  type OstiaExtension,
  ok,
  parseFlags,
} from '@aurigax-ai/ostia-extension-sdk'
import {
  type CommandOutput,
  connectorCatalog,
  dryRunCommand,
  explainCommand,
  nodesCommand,
  schemaCommand,
  validateCommand,
} from '@aurigax-ai/wire'
import { NATIVE_CONNECTORS } from './connectorHost'
import type { GraphsRunner } from './runner'

export type VerbsExt = Pick<OstiaExtension, 'mcpServers' | 'connections'>

async function connectorListing(ext: VerbsExt) {
  const [servers, connections] = await Promise.all([
    ext.mcpServers().catch(() => null),
    ext.connections().catch(() => null),
  ])
  return {
    mcp: servers?.ok ? servers.servers.map((s) => ({ server: s.name, tools: s.tools })) : [],
    native: connectorCatalog(NATIVE_CONNECTORS),
    connections: connections?.ok
      ? connections.connections.map((c) => ({ name: c.name, kind: c.kind }))
      : [],
  }
}

async function nodesListing(
  runner: GraphsRunner,
  ext: VerbsExt,
  caller: ExtensionCaller,
): Promise<CommandOutput> {
  const out = nodesCommand(runner.host.kinds.map((k) => k.kind))
  const kinds = JSON.parse(out.stdout) as { kind: string }[]
  const scratch = runner.workspace(caller.workspaceId)?.kind === 'scratch'
  const listing = caller.sandboxed
    ? { refused: 'sandboxed' }
    : scratch
      ? { refused: 'scratch' }
      : await connectorListing(ext)
  const shown = kinds.map((k) => (k.kind === 'connector' ? { ...k, connectors: listing } : k))
  return { exitCode: 0, stdout: `${JSON.stringify(shown, null, 2)}\n` }
}

function repeated(argv: string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = []
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}` && i + 1 < argv.length) values.push(argv[++i] as string)
    else rest.push(argv[i] as string)
  }
  return { values, rest }
}

function fromOutput(out: CommandOutput): ExtensionResult {
  if (out.exitCode === 0) return ok(out.stdout.trimEnd())
  let data: unknown
  try {
    data = JSON.parse(out.stdout)
  } catch {
    data = undefined
  }
  const problems = (data as { problems?: { code: string; message: string }[] } | undefined)
    ?.problems
  if (problems?.[0])
    return { ok: false, error: problems[0].code, message: problems[0].message, data }
  return { ok: false, error: 'failed', message: out.stdout.trimEnd() }
}

function fileOf(
  caller: ExtensionCaller,
  arg: string | undefined,
): { path: string; workDir: string } | null {
  const base = caller.cwd ?? caller.workDir
  if (!arg || !base) return null
  return { path: isAbsolute(arg) ? arg : resolve(base, arg), workDir: caller.workDir ?? base }
}

async function known(
  runner: GraphsRunner,
  refresh: () => Promise<void>,
  caller: ExtensionCaller,
): Promise<void> {
  if (!runner.workspace(caller.workspaceId)) await refresh()
}

function paneProblem(caller: ExtensionCaller): ExtensionResult | null {
  if (caller.kind !== 'pane' || !caller.paneId || !caller.workspaceId) {
    return failure('not-available', 'only a pane of the graph’s own workspace can do this')
  }
  if (caller.manager) return failure('not-available', 'the manager pane has no graphs')
  if (caller.remote) return failure('remote', 'a remote pane has no graphs')
  return null
}

export function graphVerbs(
  runner: GraphsRunner,
  refresh: () => Promise<void>,
  ext: VerbsExt,
): Record<string, CommandHandler> {
  const withFile =
    (
      fn: (path: string, workDir: string, argv: string[]) => CommandOutput | Promise<CommandOutput>,
    ): CommandHandler =>
    async (args, caller) => {
      const argv = cliArgs(args)?.argv ?? []
      const file = fileOf(caller, argv[0])
      if (!file)
        return failure('usage', 'a graph file is needed, such as .ostia/graphs/<name>.yaml')
      return fromOutput(await fn(file.path, file.workDir, argv.slice(1)))
    }
  return {
    validate: withFile((path, workDir) => validateCommand(path, workDir)),
    schema: () => fromOutput(schemaCommand()),
    nodes: async (_args, caller) => fromOutput(await nodesListing(runner, ext, caller)),
    explain: withFile((path, workDir) => explainCommand(path, workDir)),
    'dry-run': withFile((path, workDir, rest) => {
      const inputs = repeated(rest, 'input')
      const mocks = repeated(inputs.rest, 'mock')
      const json = repeated(mocks.rest, 'input-json')
      return dryRunCommand({
        path,
        workDir,
        inputs: inputs.values,
        mocks: mocks.values,
        json: json.rest.includes('--json'),
        ...(json.values[0] ? { inputJson: json.values[0] } : {}),
      })
    }),
    list: async (_args, caller) => {
      const refused = paneProblem(caller)
      if (refused) return refused
      await known(runner, refresh, caller)
      const graphs = await runner.graphs(caller.workspaceId as string)
      if ('error' in graphs) return failure(graphs.error)
      return ok(
        undefined,
        graphs.map((g) => ({
          name: g.entry.name,
          state: g.state,
          ...(g.entry.loaded?.graph.description
            ? { description: g.entry.loaded.graph.description }
            : {}),
          ...(g.problems.length > 0 ? { problems: g.problems } : {}),
        })),
      )
    },
    runs: async (args, caller) => {
      const refused = paneProblem(caller)
      if (refused) return refused
      await known(runner, refresh, caller)
      const name = cliArgs(args)?.argv[0]
      if (runner.workspace(caller.workspaceId)?.kind === 'scratch') return failure('scratch')
      return ok(undefined, await runner.runs(caller.workspaceId as string, name))
    },
    show: async (args, caller) => {
      const refused = paneProblem(caller)
      if (refused) return refused
      await known(runner, refresh, caller)
      const { flags, rest } = parseFlags(cliArgs(args)?.argv ?? [], ['node'])
      const view = rest[0] ? await runner.view(caller.workspaceId as string, rest[0]) : null
      if (!view) return failure('unknown-run', rest[0] ?? 'a run id is needed')
      return ok(
        undefined,
        flags.node ? { ...view, nodes: view.nodes.filter((n) => n.node === flags.node) } : view,
      )
    },
    run: async (args, caller) => {
      const refused = paneProblem(caller)
      if (refused) return refused
      await known(runner, refresh, caller)
      const argv = cliArgs(args)?.argv ?? []
      const inputs = repeated(argv.slice(1), 'input')
      const json = repeated(inputs.rest, 'input-json')
      if (!argv[0]) return failure('usage', 'ostia graph run <name> [--input key=value]…')
      const res = await runner.start(caller.workspaceId as string, argv[0], {
        byAgent: true,
        pane: caller.paneId as string,
        inputs: inputs.values,
        ...(json.values[0] ? { inputJson: json.values[0] } : {}),
      })
      if (!res.ok) return failure(res.error, res.message)
      return 'runId' in res ? ok(res.runId, { runId: res.runId }) : ok('queued', { queued: true })
    },
    report: async (args, caller) => {
      if (caller.kind !== 'pane' || !caller.paneId) return failure('not-available')
      const { flags } = parseFlags(cliArgs(args)?.argv ?? [], ['json', 'run'])
      let value: unknown
      try {
        value = JSON.parse(flags.json ?? '')
      } catch {
        return failure('bad-result', '--json is one JSON object')
      }
      const res = await runner.report(caller.paneId, value, flags.run)
      return res.ok ? ok('report accepted') : failure(res.error, res.message)
    },
  }
}
