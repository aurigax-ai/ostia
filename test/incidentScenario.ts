import {
  INCIDENT_BLOCK_TAG,
  type IncidentBlock,
  incidentBlockSchema,
} from '../src/shared/agents/incident'

export interface IncidentScenario {
  method: 'pane.input' | 'pane.wait'
  trigger: string
  swallowEnter: boolean
  silentAgent: boolean
  draft: boolean
  callMs: number
}

export type ScenarioResult =
  | { ok: true; scenario: IncidentScenario; block: IncidentBlock }
  | { ok: false; reason: string }

const BLOCK = new RegExp(`\`\`\`${INCIDENT_BLOCK_TAG} json\\n([\\s\\S]*?)\\n\`\`\``)

export function blockOf(report: string): IncidentBlock | null {
  const match = BLOCK.exec(report)
  if (!match?.[1]) return null
  try {
    return incidentBlockSchema.parse(JSON.parse(match[1]))
  } catch {
    return null
  }
}

export function scenarioOf(report: string): ScenarioResult {
  const block = blockOf(report)
  if (!block) return { ok: false, reason: `no valid ${INCIDENT_BLOCK_TAG} block in the file` }
  const calls = block.events.flatMap((e) => (e.k === 'call' ? [e] : []))
  const draft = calls.some((e) => e.before?.drafting === true || e.after?.drafting === true)
  const callMs = Math.max(0, ...calls.map((e) => e.ms ?? 0))
  const methods = new Set(calls.map((e) => e.method))
  const base = { trigger: block.trigger, draft, callMs }
  if (block.trigger === 'not-submitted' && methods.has('pane.input')) {
    return {
      ok: true,
      block,
      scenario: { ...base, method: 'pane.input', swallowEnter: true, silentAgent: false },
    }
  }
  if (block.trigger === 'call-open' && methods.has('pane.wait')) {
    return {
      ok: true,
      block,
      scenario: { ...base, method: 'pane.wait', swallowEnter: false, silentAgent: true },
    }
  }
  return { ok: false, reason: `no replay model for trigger ${block.trigger}` }
}
