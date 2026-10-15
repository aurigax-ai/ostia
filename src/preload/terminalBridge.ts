import { ipcRenderer } from 'electron'
import type { HibernateOutcome } from '../shared/agents/agentWork'
import type { SelectionSendResult } from '../shared/browser/selection'
import type { OpenFileVerdict } from '../shared/files/openFiles'
import type { SpecCommand } from '../shared/terminal/completionSpec'
import type {
  HistoryBlockRange,
  HistoryPage,
  HistorySearchResult,
} from '../shared/terminal/scrollbackHistory'
import type {
  FsKind,
  OpenPathResult,
  OstiaBridge,
  PaneActivity,
  PromptContext,
  PtyAttachResult,
} from '../shared/types'

export const terminalBridge: Pick<
  OstiaBridge,
  'pty' | 'terminalLinks' | 'selection' | 'completions'
> = {
  pty: {
    attach: (paneId, opts) =>
      ipcRenderer.invoke('pty:attach', paneId, opts) as Promise<PtyAttachResult>,
    detach: (paneId) => ipcRenderer.send('pty:detach', paneId),
    hibernate: (paneId) => ipcRenderer.invoke('pty:hibernate', paneId) as Promise<HibernateOutcome>,
    stashed: (paneId) => ipcRenderer.invoke('pty:stashed', paneId) as Promise<string | null>,
    historyRead: (paneId, from, count) =>
      ipcRenderer.invoke('pty:history-read', paneId, from, count) as Promise<HistoryPage | null>,
    historySearch: (paneId, query, options, liveLines) =>
      ipcRenderer.invoke(
        'pty:history-search',
        paneId,
        query,
        options,
        liveLines,
      ) as Promise<HistorySearchResult | null>,
    historyBlock: (paneId, seq, command) =>
      ipcRenderer.invoke(
        'pty:history-block',
        paneId,
        seq,
        command,
      ) as Promise<HistoryBlockRange | null>,
    blockOutput: (paneId, seq, command) =>
      ipcRenderer.invoke('pty:block-output', paneId, seq, command) as Promise<string | null>,
    keptWaiting: () => ipcRenderer.invoke('pty:kept-waiting') as Promise<string[]>,
    restart: (paneId) => ipcRenderer.invoke('pty:restart', paneId) as Promise<boolean>,
    reportAgentRunning: (paneId, running) => ipcRenderer.send('pty:agent-running', paneId, running),
    reportWaking: (paneId, waking) => ipcRenderer.send('pty:waking', paneId, waking),
    write: (paneId, data) => ipcRenderer.send('pty:write', paneId, data),
    ack: (paneId, chars) => ipcRenderer.send('pty:ack', paneId, chars),
    resize: (paneId, cols, rows) => ipcRenderer.send('pty:resize', paneId, cols, rows),
    commands: (paneId) => ipcRenderer.invoke('pty:commands', paneId) as Promise<string[]>,
    listDir: (paneId, dir) => ipcRenderer.invoke('pty:list-dir', paneId, dir),
    history: (paneId) => ipcRenderer.invoke('pty:history', paneId),
    localPrompt: (paneId) => ipcRenderer.invoke('pty:local-prompt', paneId),
    foreground: (paneId) => ipcRenderer.invoke('pty:foreground', paneId) as Promise<string | null>,
    activity: (paneId) =>
      ipcRenderer.invoke('pty:activity', paneId) as Promise<PaneActivity | null>,
    promptContext: (paneId, want) =>
      ipcRenderer.invoke('pty:prompt-context', paneId, want) as Promise<PromptContext | null>,
    onData: (paneId, cb) => {
      const handler = (_e: unknown, data: string): void => cb(data)
      ipcRenderer.on(`pty:data:${paneId}`, handler)
      return () => ipcRenderer.removeListener(`pty:data:${paneId}`, handler)
    },
    onExit: (paneId, cb) => {
      const handler = (_e: unknown, code: number, closes: boolean): void => cb(code, closes)
      ipcRenderer.on(`pty:exit:${paneId}`, handler)
      return () => ipcRenderer.removeListener(`pty:exit:${paneId}`, handler)
    },
    onSize: (paneId, cb) => {
      const handler = (_e: unknown, cols: number, rows: number): void => cb(cols, rows)
      ipcRenderer.on(`pty:size:${paneId}`, handler)
      return () => ipcRenderer.removeListener(`pty:size:${paneId}`, handler)
    },
    onRun: (cb) => {
      const handler = (_e: unknown, paneId: string, command: string): void => cb(paneId, command)
      ipcRenderer.on('pty:run', handler)
      return () => ipcRenderer.removeListener('pty:run', handler)
    },
  },
  terminalLinks: {
    probe: (paneId, path) =>
      ipcRenderer.invoke('terminal-links:probe', paneId, path) as Promise<FsKind | null>,
    admit: (paneId, written) =>
      ipcRenderer.invoke(
        'terminal-links:admit',
        paneId,
        written,
      ) as Promise<OpenFileVerdict | null>,
    openDefault: (paneId, written) =>
      ipcRenderer.invoke('terminal-links:open-default', paneId, written) as Promise<OpenPathResult>,
    showInFolder: (paneId, written) =>
      ipcRenderer.invoke(
        'terminal-links:show-in-folder',
        paneId,
        written,
      ) as Promise<OpenPathResult>,
  },
  selection: {
    send: (req) => ipcRenderer.invoke('selection:send', req) as Promise<SelectionSendResult>,
  },
  completions: {
    spec: (command) =>
      ipcRenderer.invoke('completions:spec', command) as Promise<SpecCommand | null>,
  },
}
