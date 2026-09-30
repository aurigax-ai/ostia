type SelectionSender = () => void

const senders = new Map<string, SelectionSender>()

export function registerSelectionSender(paneId: string, sender: SelectionSender): () => void {
  senders.set(paneId, sender)
  return () => {
    if (senders.get(paneId) === sender) senders.delete(paneId)
  }
}

export function openSelectionSend(paneId: string): boolean {
  const sender = senders.get(paneId)
  if (!sender) return false
  sender()
  return true
}
