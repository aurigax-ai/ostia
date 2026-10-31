import {
  type AgentBusyReason,
  HIBERNATE_HELD,
  isAgentBusyReason,
} from '../../../shared/agents/agentWork'

const IN_TURN: ReadonlySet<string | undefined> = new Set(['working', 'waiting'])

export interface MovePane {
  paneId: string
  agent?: string
  session?: string
  hibernated: boolean
  waking: boolean
}

export interface AccountMovesDeps {
  current: () => string
  accountOf: (paneId: string) => string | undefined
  panes: () => Promise<MovePane[]>
  isolated: (paneId: string) => boolean
  turnState: (paneId: string) => string | undefined
  busy: (paneId: string) => Promise<AgentBusyReason | null>
  drafting: (paneId: string) => boolean
  inputCount: (paneId: string) => number | undefined
  hibernate: (paneId: string) => Promise<string>
  wake: (paneId: string) => Promise<boolean>
  waking: { start: (paneId: string) => void; abandon: (paneId: string) => void }
  stays: (paneId: string) => void
}

export class AccountMoves {
  private readonly owed = new Set<string>()
  private readonly moving = new Set<string>()
  private readonly marks = new Map<string, number | undefined>()

  constructor(private readonly deps: AccountMovesDeps) {}

  async switched(): Promise<void> {
    for (const pane of await this.deps.panes()) {
      if (!this.onOtherAccount(pane)) continue
      if (pane.session) this.owed.add(pane.paneId)
      else this.deps.stays(pane.paneId)
    }
    await Promise.all([...this.owed].map((paneId) => this.idle(paneId)))
  }

  async idle(paneId: string): Promise<void> {
    if (!this.owed.has(paneId) || this.moving.has(paneId)) return
    this.moving.add(paneId)
    try {
      await this.move(paneId)
    } finally {
      this.moving.delete(paneId)
      this.marks.delete(paneId)
    }
  }

  closed(paneId: string): void {
    this.owed.delete(paneId)
  }

  holds(paneId: string, inputCount: number): boolean {
    if (!this.marks.has(paneId)) return false
    return this.marks.get(paneId) !== inputCount || IN_TURN.has(this.deps.turnState(paneId))
  }

  private onOtherAccount(pane: MovePane): boolean {
    if (pane.agent !== 'claude' || pane.hibernated || this.deps.isolated(pane.paneId)) return false
    const account = this.deps.accountOf(pane.paneId)
    return account !== undefined && account !== this.deps.current()
  }

  private quiet(paneId: string): boolean {
    return !IN_TURN.has(this.deps.turnState(paneId)) && !this.deps.drafting(paneId)
  }

  private async move(paneId: string): Promise<void> {
    this.marks.set(paneId, this.deps.inputCount(paneId))
    const pane = (await this.deps.panes()).find((entry) => entry.paneId === paneId)
    if (!pane?.session || !this.onOtherAccount(pane)) {
      this.owed.delete(paneId)
      return
    }
    if (pane.waking || !this.quiet(paneId) || (await this.deps.busy(paneId))) return
    if (!this.owed.has(paneId) || !this.quiet(paneId)) return
    const outcome = await this.deps.hibernate(paneId)
    if (outcome !== 'hibernated') {
      if (outcome !== HIBERNATE_HELD && !isAgentBusyReason(outcome)) this.owed.delete(paneId)
      return
    }
    this.owed.delete(paneId)
    this.deps.waking.start(paneId)
    if (!(await this.deps.wake(paneId).catch(() => false))) this.deps.waking.abandon(paneId)
  }
}
