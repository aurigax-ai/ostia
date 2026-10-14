import { type ExtensionResult, type OstiaExtension, failure, namedArgs, ok } from '../sdk'
import { definition, listModel, runModel } from './panelModel'
import type { GraphsRunner } from './runner'

export type PanelHandler = (args: unknown) => Promise<ExtensionResult>

const CONTROLS = ['pause', 'resume', 'cancel', 'retry', 'rerun', 'skip', 'continue']

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function panelHandlers(
  runner: GraphsRunner,
  ext: Pick<OstiaExtension, 'listPanes' | 'focusPane'>,
  refresh: () => Promise<void>,
): Record<string, PanelHandler> {
  const workspaceOf = (args: unknown) =>
    runner.workspace(text(namedArgs(args).workspaceId) ?? undefined)
  return {
    list: async (args) => {
      await refresh()
      const w = workspaceOf(args)
      if (!w) return failure('unknown-workspace')
      const listings = runner.graphs(w.workspaceId)
      if ('error' in listings) {
        return listings.error === 'scratch'
          ? ok(undefined, { workspaceId: w.workspaceId, folder: '', scratch: true, graphs: [] })
          : failure(listings.error)
      }
      return ok(
        undefined,
        listModel(w.workspaceId, w.workDir, listings, runner.runs(w.workspaceId)),
      )
    },
    definition: async (args) => {
      const w = workspaceOf(args)
      const name = text(namedArgs(args).name)
      if (!w || !name) return failure('invalid-args')
      const listing = runner.graph(w.workspaceId, name)
      const shown = listing ? definition(listing) : null
      if (!listing || !shown)
        return failure(listing?.problems[0]?.code ?? 'unknown-graph', listing?.problems[0]?.message)
      return ok(undefined, { ...shown, state: listing.state })
    },
    enable: async (args) => {
      const w = workspaceOf(args)
      const name = text(namedArgs(args).name)
      const fingerprint = text(namedArgs(args).fingerprint)
      if (!w || !name || !fingerprint) return failure('invalid-args')
      const res = runner.enable(w.workspaceId, name, fingerprint)
      return res.ok ? ok() : failure(res.error, res.message)
    },
    disable: async (args) => {
      const w = workspaceOf(args)
      const name = text(namedArgs(args).name)
      if (!w || !name) return failure('invalid-args')
      const res = runner.disable(w.workspaceId, name)
      return res.ok ? ok() : failure(res.error, res.message)
    },
    runNow: async (args) => {
      const w = workspaceOf(args)
      const name = text(namedArgs(args).name)
      if (!w || !name) return failure('invalid-args')
      const inputs = namedArgs(args).inputs
      const res = runner.start(w.workspaceId, name, {
        byAgent: false,
        inputs: Array.isArray(inputs)
          ? inputs.filter((i): i is string => typeof i === 'string')
          : [],
      })
      if (!res.ok) return failure(res.error, res.message)
      return ok(undefined, 'runId' in res ? { runId: res.runId } : { queued: true })
    },
    runs: async (args) => {
      const w = workspaceOf(args)
      if (!w) return failure('unknown-workspace')
      return ok(undefined, runner.runs(w.workspaceId, text(namedArgs(args).name) ?? undefined))
    },
    run: async (args) => {
      const w = workspaceOf(args)
      const runId = text(namedArgs(args).runId)
      if (!w || !runId) return failure('invalid-args')
      const view = runner.view(w.workspaceId, runId)
      if (!view) return failure('unknown-run')
      const panes = new Set((await ext.listPanes()).map((p) => p.paneId))
      return ok(undefined, runModel(view, panes))
    },
    control: async (args) => {
      const w = workspaceOf(args)
      const p = namedArgs(args)
      const runId = text(p.runId)
      const action = text(p.action)
      if (!w || !runId || !action || !CONTROLS.includes(action)) return failure('invalid-args')
      const res = await runner.control(w.workspaceId, runId, action, text(p.node) ?? undefined)
      return res.ok ? ok() : failure(res.error, res.message)
    },
    focus: async (args) => {
      const paneId = text(namedArgs(args).paneId)
      return paneId ? ext.focusPane(paneId) : failure('invalid-args')
    },
  }
}
