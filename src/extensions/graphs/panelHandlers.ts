import {
  type ExtensionResult,
  failure,
  namedArgs,
  type OstiaExtension,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import { definition, listModel, runModel, runtimeModel } from './panelModel'
import type { GraphListing, GraphsRunner } from './runner'

export type PanelHandler = (args: unknown) => Promise<ExtensionResult>

const CONTROLS = ['pause', 'resume', 'cancel', 'retry', 'rerun', 'skip', 'continue']

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

async function secretShapedInputs(
  ext: Pick<OstiaExtension, 'redact'>,
  listing: GraphListing,
): Promise<Set<string>> {
  const nodes = (listing.entry.loaded?.graph.nodes ?? []).filter(
    (n) => n.kind === 'connector' && n.with?.input !== undefined,
  )
  if (nodes.length === 0) return new Set()
  const texts = nodes.map((n) => JSON.stringify(n.with?.input))
  const redacted = await ext.redact(texts)
  if (!redacted) return new Set(nodes.map((n) => n.id))
  return new Set(nodes.filter((_n, i) => redacted[i] !== texts[i]).map((n) => n.id))
}

export function panelHandlers(
  runner: GraphsRunner,
  ext: Pick<OstiaExtension, 'listPanes' | 'focusPane' | 'redact'>,
  refresh: () => Promise<void>,
): Record<string, PanelHandler> {
  const workspaceOf = async (args: unknown) => {
    const id = text(namedArgs(args).workspaceId) ?? undefined
    if (!runner.workspace(id)) await refresh()
    return runner.workspace(id)
  }
  return {
    list: async (args) => {
      await refresh()
      const w = await workspaceOf(args)
      if (!w) return failure('unknown-workspace')
      const listings = await runner.graphs(w.workspaceId)
      if ('error' in listings) {
        return listings.error === 'scratch'
          ? ok(undefined, { workspaceId: w.workspaceId, folder: '', scratch: true, graphs: [] })
          : failure(listings.error, listings.message)
      }
      return ok(undefined, listModel(w.workspaceId, listings, await runner.runs(w.workspaceId)))
    },
    runtime: async () => {
      await runner.link.ensure()
      return ok(undefined, runtimeModel(runner.state))
    },
    definition: async (args) => {
      const w = await workspaceOf(args)
      const name = text(namedArgs(args).name)
      if (!w || !name) return failure('invalid-args')
      const listing = await runner.graph(w.workspaceId, name)
      const shown = listing ? definition(listing, await secretShapedInputs(ext, listing)) : null
      if (!listing || !shown)
        return failure(listing?.problems[0]?.code ?? 'unknown-graph', listing?.problems[0]?.message)
      return ok(undefined, { ...shown, state: listing.state })
    },
    enable: async (args) => {
      const w = await workspaceOf(args)
      const name = text(namedArgs(args).name)
      const fingerprint = text(namedArgs(args).fingerprint)
      if (!w || !name || !fingerprint) return failure('invalid-args')
      const res = await runner.enable(w.workspaceId, name, fingerprint)
      if (res.ok) await refresh()
      return res.ok ? ok() : failure(res.error, res.message)
    },
    disable: async (args) => {
      const w = await workspaceOf(args)
      const name = text(namedArgs(args).name)
      if (!w || !name) return failure('invalid-args')
      const res = await runner.disable(w.workspaceId, name)
      if (res.ok) await refresh()
      return res.ok ? ok() : failure(res.error, res.message)
    },
    runNow: async (args) => {
      const w = await workspaceOf(args)
      const name = text(namedArgs(args).name)
      if (!w || !name) return failure('invalid-args')
      const inputs = namedArgs(args).inputs
      const res = await runner.start(w.workspaceId, name, {
        byAgent: false,
        inputs: Array.isArray(inputs)
          ? inputs.filter((i): i is string => typeof i === 'string')
          : [],
      })
      if (!res.ok) return failure(res.error, res.message)
      return ok(undefined, 'runId' in res ? { runId: res.runId } : { queued: true })
    },
    runs: async (args) => {
      const w = await workspaceOf(args)
      if (!w) return failure('unknown-workspace')
      return ok(
        undefined,
        await runner.runs(w.workspaceId, text(namedArgs(args).name) ?? undefined),
      )
    },
    run: async (args) => {
      const w = await workspaceOf(args)
      const runId = text(namedArgs(args).runId)
      if (!w || !runId) return failure('invalid-args')
      const view = await runner.view(w.workspaceId, runId)
      if (!view) return failure('unknown-run')
      const panes = new Set((await ext.listPanes()).map((p) => p.paneId))
      return ok(undefined, runModel(view, panes))
    },
    control: async (args) => {
      const w = await workspaceOf(args)
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
