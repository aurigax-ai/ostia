import {
  actThenConfirm,
  confirmed,
  mismatch,
  type Subscribe,
} from '../../shared/common/actThenConfirm'
import { CLOSE_CONFIRM_MS } from '../../shared/windows/closeWaits'
import type { PaneIdentity } from '../control/idRegistry'
import type { PaneEntry } from './paneList'

export const CONFIRM_MAX_MS = 10_000
const CONFIRM_POLL_MS = 50
const SUBMIT_CONFIRM_MS = 5000
const TURN_STATES: ReadonlySet<string | undefined> = new Set(['working', 'waiting'])

interface PaneConfirmDeps {
  io: { outputCursor: (paneId: string) => number | undefined }
  attention: (pane: PaneIdentity) => Promise<{ state?: string }>
  panes: () => Promise<PaneEntry[]>
  delay: (ms: number) => Promise<void>
  hooksOn: (agent: string) => boolean
}

export type PaneConfirms = ReturnType<typeof createPaneConfirms>

export function createPaneConfirms(deps: PaneConfirmDeps) {
  const ticks: Subscribe = (wake) => {
    let on = true
    void (async () => {
      while (on) {
        await deps.delay(CONFIRM_POLL_MS)
        if (on) wake()
      }
    })()
    return () => {
      on = false
    }
  }

  const confirmGone = (to: PaneIdentity) => {
    let polls = 0
    return actThenConfirm<true>({
      act: () => undefined,
      observe: async () => {
        const listed = await deps.panes()
        if (!listed.some((p) => p.paneId === to.externalId)) return confirmed(true)
        polls += 1
        if (polls * CONFIRM_POLL_MS <= CLOSE_CONFIRM_MS) return undefined
        return mismatch(
          `still-open: ${to.externalId} is still open; the human was asked about its unsaved files`,
        )
      },
      signal: ticks,
      timeoutMs: CLOSE_CONFIRM_MS * 10,
      onTimeout: () => mismatch(`still-open: ${to.externalId} is still open`),
    })
  }

  const confirmInput = async (
    to: PaneIdentity,
    before: number | undefined,
    ms: number,
  ): Promise<boolean> => {
    let polls = 0
    const seen = await actThenConfirm<boolean>({
      act: () => undefined,
      observe: () => {
        const now = deps.io.outputCursor(to.paneId)
        if (now === undefined) return confirmed(false)
        if (before !== undefined && now > before) return confirmed(true)
        polls += 1
        return polls * CONFIRM_POLL_MS > ms ? confirmed(false) : undefined
      },
      signal: ticks,
      timeoutMs: CONFIRM_MAX_MS * 10,
      onTimeout: () => confirmed(false),
    })
    return seen.value === true
  }

  const confirmSubmitted = (to: PaneIdentity) => {
    let polls = 0
    return actThenConfirm<true>({
      act: () => undefined,
      observe: async () => {
        if (TURN_STATES.has((await deps.attention(to)).state)) return confirmed(true)
        polls += 1
        if (polls * CONFIRM_POLL_MS <= SUBMIT_CONFIRM_MS) return undefined
        return mismatch(
          `not-submitted: ${to.externalId} shows the text at its prompt but did not start a turn after Enter; press Enter with ostia pane key ${to.externalId} enter, or read it with ostia pane read`,
        )
      },
      signal: ticks,
      timeoutMs: SUBMIT_CONFIRM_MS * 10,
      onTimeout: () => mismatch(`not-submitted: ${to.externalId} did not start a turn`),
    })
  }

  const watchesSubmit = async (to: PaneIdentity): Promise<boolean> => {
    const entry = (await deps.panes()).find((p) => p.paneId === to.externalId)
    if (!entry?.agent || !deps.hooksOn(entry.agent)) return false
    return !TURN_STATES.has((await deps.attention(to)).state)
  }

  return { confirmGone, confirmInput, confirmSubmitted, watchesSubmit }
}
