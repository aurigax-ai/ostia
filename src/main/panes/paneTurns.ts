import {
  normalizeTurnReport,
  type TurnReport,
  type TurnStepKind,
} from '../../shared/agents/turnHook'
import { registerControlMethod } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'

export const PANE_TURNS_MAX = 50
const TURN_STEPS_MAX = 200
export const TURN_OUTPUTS_MAX = 20

interface TurnStep {
  id: string
  kind: TurnStepKind
  target?: string
  exitCode?: number
  output: boolean
}

export interface Turn {
  id: string
  startedAt: number
  prompt?: string
  steps: TurnStep[]
  final?: string
  commands: number
  filesEdited: number
  ended: boolean
}

interface PaneRecord {
  turns: Turn[]
  edited: Map<string, Set<string>>
  outputs: Map<string, string>
  nextId: number
}

export class PaneTurns {
  private readonly panes = new Map<string, PaneRecord>()

  constructor(private readonly now: () => number = Date.now) {}

  private paneRecord(paneId: string): PaneRecord {
    let pane = this.panes.get(paneId)
    if (!pane) {
      pane = { turns: [], edited: new Map(), outputs: new Map(), nextId: 1 }
      this.panes.set(paneId, pane)
    }
    return pane
  }

  private startTurn(pane: PaneRecord, prompt?: string): Turn {
    const turn: Turn = {
      id: `t${pane.nextId++}`,
      startedAt: this.now(),
      ...(prompt ? { prompt } : {}),
      steps: [],
      commands: 0,
      filesEdited: 0,
      ended: false,
    }
    pane.turns.push(turn)
    while (pane.turns.length > PANE_TURNS_MAX) {
      const dropped = pane.turns.shift()
      if (!dropped) break
      pane.edited.delete(dropped.id)
      for (const step of dropped.steps) pane.outputs.delete(step.id)
    }
    return turn
  }

  private latestTurn(pane: PaneRecord): Turn {
    return pane.turns.at(-1) ?? this.startTurn(pane)
  }

  report(paneId: string, report: TurnReport): void {
    const pane = this.paneRecord(paneId)
    if (report.kind === 'prompt') {
      const open = pane.turns.at(-1)
      if (open && !open.ended) open.ended = true
      this.startTurn(pane, report.text)
      return
    }
    const turn = this.latestTurn(pane)
    if (report.kind === 'stop') {
      if (report.message) turn.final = report.message
      turn.ended = true
      return
    }
    if (turn.steps.length >= TURN_STEPS_MAX) return
    const step: TurnStep = {
      id: `${turn.id}s${turn.steps.length + 1}`,
      kind: report.step,
      ...(report.target ? { target: report.target } : {}),
      ...(report.exitCode === undefined ? {} : { exitCode: report.exitCode }),
      output: report.output !== undefined,
    }
    turn.steps.push(step)
    if (report.step === 'command') turn.commands += 1
    if (report.step === 'edit' && report.target) {
      const files = pane.edited.get(turn.id) ?? new Set<string>()
      files.add(report.target)
      pane.edited.set(turn.id, files)
      turn.filesEdited = files.size
    }
    if (report.output !== undefined) this.keepOutput(pane, step.id, report.output)
  }

  private keepOutput(pane: PaneRecord, stepId: string, output: string): void {
    pane.outputs.set(stepId, output)
    while (pane.outputs.size > TURN_OUTPUTS_MAX) {
      const oldest = pane.outputs.keys().next().value
      if (oldest === undefined) break
      pane.outputs.delete(oldest)
      for (const t of pane.turns) {
        const gone = t.steps.find((s) => s.id === oldest)
        if (gone) gone.output = false
      }
    }
  }

  list(paneId: string): Turn[] {
    return (this.panes.get(paneId)?.turns ?? []).map((turn) => ({
      ...turn,
      steps: turn.steps.map((step) => ({ ...step })),
    }))
  }

  output(paneId: string, stepId: string): string | null {
    return this.panes.get(paneId)?.outputs.get(stepId) ?? null
  }

  drop(paneId: string): void {
    this.panes.delete(paneId)
  }
}

export function registerPaneTurnMethods(
  turns: PaneTurns,
  onBoundary: (identity: PaneIdentity) => void,
): void {
  registerControlMethod('pane.reportTurn', {
    cap: 'drive-self',
    handler: async (params: unknown, ctx) => {
      if (ctx.identity.kind !== 'pane' || !ctx.identity.paneId) {
        return { ok: false, error: 'not-a-pane' }
      }
      const report = normalizeTurnReport(params)
      if (report) turns.report(ctx.identity.paneId, report)
      if (report?.kind === 'prompt' || report?.kind === 'stop') onBoundary(ctx.identity)
      return { ok: true }
    },
  })
}
