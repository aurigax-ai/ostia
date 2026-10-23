type SelectionSender = () => void

const senders = new Map<string, SelectionSender[]>()

export function registerSelectionSender(paneId: string, sender: SelectionSender): () => void {
  senders.set(paneId, [...(senders.get(paneId) ?? []), sender])
  return () => {
    const rest = (senders.get(paneId) ?? []).filter((held) => held !== sender)
    if (rest.length > 0) senders.set(paneId, rest)
    else senders.delete(paneId)
  }
}

export function openSelectionSend(paneId: string): boolean {
  const sender = senders.get(paneId)?.at(-1)
  if (!sender) return false
  sender()
  return true
}
