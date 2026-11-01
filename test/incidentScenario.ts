import {
  INCIDENT_BLOCK_TAG,
  type IncidentBlock,
  incidentBlockSchema,
} from '../src/shared/agents/incident'

type Replay = 'send-enter' | 'wait' | 'wake' | 'mail' | 'run-outside'

export interface IncidentScenario {
  replay: Replay
  trigger: string
  accept: string[]
  swallowEnter: boolean
  neverDone: boolean
  silentWake: boolean
  hooksOff: boolean
  draft: boolean
  callMs: number
}

export type ScenarioResult =
  | { ok: true; scenario: IncidentScenario; block: IncidentBlock }
  | { ok: false; reason: string }

const BLOCK = new RegExp(`\`\`\`${INCIDENT_BLOCK_TAG} json\\n([\\s\\S]*?)\\n\`\`\``)

const NONE = {
  swallowEnter: false,
  neverDone: false,
  silentWake: false,
  hooksOff: false,
}

export function blockOf(report: string): IncidentBlock | null {
  const match = BLOCK.exec(report)
  if (!match?.[1]) return null
  try {
    return incidentBlockSchema.parse(JSON.parse(match[1]))
  } catch {
    return null
  }
}

function modelOf(trigger: string, methods: Set<string>): Partial<IncidentScenario> | null {
  if (trigger === 'not-submitted' && methods.has('pane.input')) {
    return { replay: 'send-enter', swallowEnter: true }
  }
  if (trigger === 'call-open' && methods.has('pane.wait')) {
    return { replay: 'wait', neverDone: true }
  }
  if (trigger === 'wake-not-ready' || (trigger === 'not-started' && methods.has('pane.wake'))) {
    return { replay: 'wake', silentWake: true, accept: ['wake-not-ready', 'not-started'] }
  }
  if (trigger === 'undelivered-hooks-off') return { replay: 'mail', hooksOff: true }
  if (trigger === 'undelivered-idle-no-wake') return { replay: 'mail' }
  if (trigger === 'folder-not-trusted') return { replay: 'run-outside' }
  return null
}

export function scenarioOf(report: string): ScenarioResult {
  const block = blockOf(report)
  if (!block) return { ok: false, reason: `no valid ${INCIDENT_BLOCK_TAG} block in the file` }
  const calls = block.events.flatMap((e) => (e.k === 'call' ? [e] : []))
  const draft = calls.some((e) => e.before?.drafting === true || e.after?.drafting === true)
  const callMs = Math.max(0, ...calls.map((e) => e.ms ?? 0))
  const model = modelOf(block.trigger, new Set(calls.map((e) => e.method)))
  if (!model?.replay) return { ok: false, reason: `no replay model for trigger ${block.trigger}` }
  return {
    ok: true,
    block,
    scenario: {
      ...NONE,
      accept: [block.trigger],
      ...model,
      replay: model.replay,
      trigger: block.trigger,
      draft,
      callMs,
    },
  }
}
