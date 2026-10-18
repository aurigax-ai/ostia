import { type BusObservation } from '../agents/busStore'
import { resolveExternal } from '../control/idRegistry'
import type { PaneJournal } from './paneJournal'

export function journalDelivered(
  journal: Pick<PaneJournal, 'mail'>,
  observation: BusObservation,
): void {
  if (observation.phase !== 'delivered') return
  const receiver = resolveExternal(observation.to)
  if (receiver?.kind === 'pane') journal.mail(receiver.paneId)
}
