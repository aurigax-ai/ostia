import type { Terminal } from '@xterm/xterm'

const terminals = new Map<string, Terminal>()

export function registerTerminal(paneId: string, term: Terminal): () => void {
  terminals.set(paneId, term)
  return () => {
    if (terminals.get(paneId) === term) terminals.delete(paneId)
  }
}

export function terminalFor(paneId: string): Terminal | undefined {
  return terminals.get(paneId)
}
