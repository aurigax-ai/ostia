import type { HistoryScroll } from './historyScroll'
import type { OstiaTerminal as Terminal } from './ostiaTerminal'
import type { TerminalText } from './terminalText'

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

export interface InputEditorHandle {
  insert: (text: string) => void
  type: (text: string) => void
  focus: () => void
  take: () => string
}

const inputEditors = new Map<string, InputEditorHandle>()

export function registerInputEditor(paneId: string, handle: InputEditorHandle): () => void {
  inputEditors.set(paneId, handle)
  return () => {
    if (inputEditors.get(paneId) === handle) inputEditors.delete(paneId)
  }
}

export function inputEditorFor(paneId: string): InputEditorHandle | undefined {
  return inputEditors.get(paneId)
}

const terminalTexts = new Map<string, TerminalText>()

export function registerTerminalText(paneId: string, text: TerminalText): () => void {
  terminalTexts.set(paneId, text)
  return () => {
    if (terminalTexts.get(paneId) === text) terminalTexts.delete(paneId)
  }
}

export function terminalTextFor(paneId: string): TerminalText | undefined {
  return terminalTexts.get(paneId)
}

const historyScrolls = new Map<string, HistoryScroll>()

export function registerHistoryScroll(paneId: string, scroll: HistoryScroll): () => void {
  historyScrolls.set(paneId, scroll)
  return () => {
    if (historyScrolls.get(paneId) === scroll) historyScrolls.delete(paneId)
  }
}

export function historyScrollFor(paneId: string): HistoryScroll | undefined {
  return historyScrolls.get(paneId)
}
