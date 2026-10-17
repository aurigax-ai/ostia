import {
  type NodeContext,
  NodeError,
  type NodeKind,
  type NodeResult,
  type Output,
  type RuntimeClient,
  serveKinds,
} from '@aurigax-ai/wire'

export interface WorkerMap {
  workspaceOf: (scope: string) => string | null
  redact: (texts: string[]) => Promise<string[] | null>
}

function strings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out)
}

function replaced(value: unknown, next: () => string): unknown {
  if (typeof value === 'string') return next()
  if (Array.isArray(value)) return value.map((v) => replaced(v, next))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaced(v, next)]))
  return value
}

async function redacted(output: Output, redact: WorkerMap['redact']): Promise<Output> {
  const texts: string[] = []
  strings(output, texts)
  if (texts.length === 0) return output
  const clean = await redact(texts).catch(() => null)
  if (!clean || clean.length !== texts.length)
    throw new NodeError('RedactionFailed', 'the secret scan failed; nothing was written')
  let i = 0
  return replaced(output, () => clean[i++] as string) as Output
}

async function cleanResult(res: NodeResult, map: WorkerMap): Promise<NodeResult> {
  if ('done' in res) return { done: await redacted(res.done, map.redact) }
  return res
}

function inWorkspace(kind: NodeKind, map: WorkerMap): NodeKind {
  const live = new Map<string, AbortController>()
  const local = (ctx: NodeContext): NodeContext => {
    const workspaceId = map.workspaceOf(ctx.scope)
    if (!workspaceId) throw new NodeError('BadOutput', 'no open workspace has this folder')
    const abort = live.get(ctx.run.attemptKey) ?? new AbortController()
    live.set(ctx.run.attemptKey, abort)
    return { ...ctx, scope: workspaceId, signal: abort.signal }
  }
  const settle = async (ctx: NodeContext, run: () => Promise<NodeResult>) => {
    try {
      const res = await run()
      if ('done' in res) live.delete(ctx.run.attemptKey)
      return cleanResult(res, map)
    } catch (err) {
      live.delete(ctx.run.attemptKey)
      throw err
    }
  }
  return {
    ...kind,
    start: (input, ctx) => {
      const here = local(ctx)
      return settle(ctx, () => kind.start(input, here))
    },
    ...(kind.resume
      ? {
          resume: (wait, event, ctx) => {
            const here = local(ctx)
            return settle(ctx, () =>
              (kind.resume as NonNullable<NodeKind['resume']>)(wait, event, here),
            )
          },
        }
      : {}),
    ...(kind.reattach
      ? {
          reattach: async (started, wait, ctx) => {
            const verdict = await (kind.reattach as NonNullable<NodeKind['reattach']>)(
              started,
              wait,
              local(ctx),
            )
            if (typeof verdict === 'object' && 'done' in verdict)
              return { done: await redacted(verdict.done, map.redact) }
            return verdict
          },
        }
      : {}),
    ...(kind.rearm
      ? {
          rearm: (wait, started, ctx) =>
            (kind.rearm as NonNullable<NodeKind['rearm']>)(wait, started, local(ctx)),
        }
      : {}),
    cancel: async (wait, started, ctx) => {
      live.get(ctx.run.attemptKey)?.abort()
      live.delete(ctx.run.attemptKey)
      if (map.workspaceOf(ctx.scope)) await kind.cancel?.(wait, started, local(ctx))
    },
  }
}

export function serveWorker(
  client: RuntimeClient,
  kinds: readonly NodeKind[],
  map: WorkerMap,
): void {
  serveKinds(
    client,
    kinds.map((k) => inWorkspace(k, map)),
    'ostia',
  )
}
