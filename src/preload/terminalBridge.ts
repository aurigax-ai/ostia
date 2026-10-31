import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const terminalBridge: Pick<
  OstiaBridge,
  'pty' | 'terminalLinks' | 'selection' | 'completions'
> = {
  pty: {
    attach: (paneId, opts) => ipcRenderer.invoke('pty:attach', paneId, opts),
    detach: (paneId) => ipcRenderer.send('pty:detach', paneId),
    hibernate: (paneId) => ipcRenderer.invoke('pty:hibernate', paneId),
    historyRead: (paneId, from, count) =>
      ipcRenderer.invoke('pty:history-read', paneId, from, count),
    historySearch: (paneId, query, options, liveLines) =>
      ipcRenderer.invoke('pty:history-search', paneId, query, options, liveLines),
    historyBlock: (paneId, seq, command) =>
      ipcRenderer.invoke('pty:history-block', paneId, seq, command),
    blockOutput: (paneId, seq, command) =>
      ipcRenderer.invoke('pty:block-output', paneId, seq, command),
    keptWaiting: () => ipcRenderer.invoke('pty:kept-waiting'),
    restart: (paneId) => ipcRenderer.invoke('pty:restart', paneId),
    reportAgentRunning: (paneId, running) => ipcRenderer.send('pty:agent-running', paneId, running),
    reportWaking: (paneId, waking, reason) =>
      ipcRenderer.send('pty:waking', paneId, waking, reason),
    write: (paneId, data, source) => ipcRenderer.send('pty:write', paneId, data, source),
    releaseHold: (paneId) => ipcRenderer.send('pty:release-hold', paneId),
    retryLink: (paneId) => ipcRenderer.send('pty:retry-link', paneId),
    ack: (paneId, chars) => ipcRenderer.send('pty:ack', paneId, chars),
    resize: (paneId, cols, rows) => ipcRenderer.send('pty:resize', paneId, cols, rows),
    commands: (paneId) => ipcRenderer.invoke('pty:commands', paneId),
    listDir: (paneId, dir) => ipcRenderer.invoke('pty:list-dir', paneId, dir),
    history: (paneId) => ipcRenderer.invoke('pty:history', paneId),
    localPrompt: (paneId) => ipcRenderer.invoke('pty:local-prompt', paneId),
    foreground: (paneId) => ipcRenderer.invoke('pty:foreground', paneId),
    activity: (paneId) => ipcRenderer.invoke('pty:activity', paneId),
    promptContext: (paneId, want) => ipcRenderer.invoke('pty:prompt-context', paneId, want),
    onData: (paneId, cb) => listen(`pty:data:${paneId}`, cb),
    onExit: (paneId, cb) => listen(`pty:exit:${paneId}`, cb),
    onLink: (paneId, cb) => listen(`pty:link:${paneId}`, cb),
    onSize: (paneId, cb) => listen(`pty:size:${paneId}`, cb),
    onRun: (cb) => listen('pty:run', cb),
  },
  terminalLinks: {
    probe: (paneId, path) => ipcRenderer.invoke('terminal-links:probe', paneId, path),
    admit: (paneId, written) => ipcRenderer.invoke('terminal-links:admit', paneId, written),
    openDefault: (paneId, written) =>
      ipcRenderer.invoke('terminal-links:open-default', paneId, written),
    showInFolder: (paneId, written) =>
      ipcRenderer.invoke('terminal-links:show-in-folder', paneId, written),
    fileUrl: (paneId, url) => ipcRenderer.invoke('terminal-links:file-url', paneId, url),
    openFileUrl: (paneId, url) => ipcRenderer.invoke('terminal-links:open-file-url', paneId, url),
  },
  selection: {
    send: (req) => ipcRenderer.invoke('selection:send', req),
  },
  completions: {
    spec: (command) => ipcRenderer.invoke('completions:spec', command),
  },
}
