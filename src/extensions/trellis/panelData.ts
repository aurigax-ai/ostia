import { call } from '@aurigax-ai/ostia-extension-sdk/panel'
import { findCard } from './board'
import {
  type BoardData,
  CARD_REF,
  type CardData,
  type CardTask,
  hooks,
  type PanelContext,
  state,
} from './panelState'
import type { VaultEntry, VaultEntrySummary } from './trellis'

async function loadContext(): Promise<void> {
  const res = await call('context')
  if (!res.ok) {
    state.failed = res
    return
  }
  state.failed = null
  state.ctx = res.data as PanelContext
  if (state.project) return
  const fromCard = state.openRef ? CARD_REF.exec(state.openRef)?.[1] : null
  state.project = fromCard ?? state.ctx.workspace?.project ?? null
  state.boardSlug =
    state.project === state.ctx.workspace?.project ? (state.ctx.workspace?.board ?? null) : null
}

async function loadBoard(seq: number): Promise<void> {
  const [res, working] = await Promise.all([
    call('board', { project: state.project, board: state.boardSlug ?? undefined }),
    call('tasks'),
  ])
  if (seq !== state.requestSeq) return
  state.boardFailure = res.ok ? null : res
  if (res.ok) state.boardData = res.data as BoardData
  if (working.ok) {
    const list = (working.data as { tasks: CardTask[] }).tasks
    state.tasks = new Map(list.map((task) => [task.ref, task]))
  }
}

async function loadCard(seq: number, ref: string): Promise<void> {
  const res = await call('card', { ref, board: state.boardData?.board.slug || undefined })
  if (seq !== state.requestSeq || state.openRef !== ref) return
  state.cardFailure = res.ok ? null : res
  if (res.ok) state.cardData = res.data as CardData
}

async function loadVault(seq: number): Promise<void> {
  const res = await call('vault', { project: state.project })
  if (seq !== state.requestSeq) return
  state.vaultFailure = res.ok ? null : res
  if (res.ok) state.entries = (res.data as { entries: VaultEntrySummary[] }).entries
  const slug = state.openSlug
  if (!slug) return
  const shown = await call('entry', { project: state.project, slug })
  if (seq !== state.requestSeq || state.openSlug !== slug) return
  state.entryFailure = shown.ok ? null : shown
  if (shown.ok) state.entryData = (shown.data as { entry: VaultEntry }).entry
}

export async function refresh(): Promise<void> {
  const seq = ++state.requestSeq
  if (!state.ctx || state.failed) await loadContext()
  if (seq !== state.requestSeq) return
  if (state.ctx && state.project) {
    if (state.view === 'vault') await loadVault(seq)
    else {
      await loadBoard(seq)
      if (seq === state.requestSeq && state.openRef) {
        if (
          state.boardData &&
          !findCard(state.boardData.board, state.openRef) &&
          state.cardData?.card.ref !== state.openRef
        ) {
          state.cardData = null
        }
        await loadCard(seq, state.openRef)
      }
    }
  }
  if (seq === state.requestSeq) hooks.render()
}
