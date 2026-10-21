import { basename, isAbsolute, relative } from 'node:path'
import { type PaneIdentity, resolveExternal } from '../../control/idRegistry'
import type { WorkspaceEntry } from '../../panes/paneList'
import type { PaneTurns, Turn } from '../../panes/paneTurns'
import type { RpcOutcome } from '../controlDispatch'

export const TURN_LIST_MAX = 20
const TURN_LIST_OUT_MAX = 256 * 1024

export interface PhoneTurnDeps {
  listWorkspaces: () => Promise<WorkspaceEntry[]>
  paneTurns: Pick<PaneTurns, 'list' | 'output'>
  redact: (text: string) => Promise<string>
  remote: (paneId: string) => boolean
}

type Params = Record<string, unknown>

function refused(message: string): RpcOutcome {
  return { ok: false, code: -32602, message }
}

const REDACTION_FAILED: RpcOutcome = { ok: false, code: -32603, message: 'redaction-failed' }

export async function turnPane(
  p: Params,
  deps: PhoneTurnDeps,
): Promise<{ pane: PaneIdentity; workDir: string } | RpcOutcome> {
  if (typeof p.paneId !== 'string' || !p.paneId) return refused('missing paneId')
  const pane = resolveExternal(p.paneId)
  if (pane?.kind !== 'pane' || pane.manager) return refused('not-an-agent')
  if (deps.remote(pane.paneId)) return refused('unknown-pane')
  const workspace = (await deps.listWorkspaces()).find((w) => w.workspaceId === pane.workspaceId)
  if (!workspace || workspace.kind === 'scratch' || workspace.sandboxed) {
    return refused('unknown-pane')
  }
  return { pane, workDir: workspace.workDir }
}

function isOutcome(value: object): value is RpcOutcome {
  return 'ok' in value
}

function shownPath(target: string, workDir: string): string {
  if (!isAbsolute(target)) return target
  const inside = relative(workDir, target)
  return inside && !inside.startsWith('..') && !isAbsolute(inside)
    ? inside
    : `…/${basename(target)}`
}

async function wireTurn(turn: Turn, workDir: string, redact: PhoneTurnDeps['redact']) {
  const steps = []
  for (const step of turn.steps) {
    const target =
      step.target === undefined
        ? undefined
        : await redact(
            step.kind === 'edit' || step.kind === 'read'
              ? shownPath(step.target, workDir)
              : step.target,
          )
    steps.push({
      id: step.id,
      kind: step.kind,
      ...(target ? { target } : {}),
      ...(step.exitCode === undefined ? {} : { exitCode: step.exitCode }),
      output: step.output,
    })
  }
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    ...(turn.prompt ? { prompt: await redact(turn.prompt) } : {}),
    steps,
    ...(turn.final ? { final: await redact(turn.final) } : {}),
    commands: turn.commands,
    filesEdited: turn.filesEdited,
    ended: turn.ended,
  }
}

export async function turnList(p: Params, deps: PhoneTurnDeps): Promise<RpcOutcome> {
  const found = await turnPane(p, deps)
  if (isOutcome(found)) return found
  const recent = deps.paneTurns.list(found.pane.paneId).slice(-TURN_LIST_MAX)
  let wired: Awaited<ReturnType<typeof wireTurn>>[]
  try {
    wired = []
    for (const turn of recent) wired.push(await wireTurn(turn, found.workDir, deps.redact))
  } catch {
    return REDACTION_FAILED
  }
  let truncated = deps.paneTurns.list(found.pane.paneId).length > wired.length
  while (wired.length > 0 && Buffer.byteLength(JSON.stringify(wired)) > TURN_LIST_OUT_MAX) {
    wired.shift()
    truncated = true
  }
  return { ok: true, result: { turns: wired, truncated } }
}

export async function turnOutput(p: Params, deps: PhoneTurnDeps): Promise<RpcOutcome> {
  const found = await turnPane(p, deps)
  if (isOutcome(found)) return found
  const stepId = p.stepId
  const output =
    typeof stepId === 'string' && stepId ? deps.paneTurns.output(found.pane.paneId, stepId) : null
  if (output === null) return refused('unknown-step')
  try {
    return { ok: true, result: { output: await deps.redact(output) } }
  } catch {
    return REDACTION_FAILED
  }
}
