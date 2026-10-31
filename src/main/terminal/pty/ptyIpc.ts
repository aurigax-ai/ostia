import { app, ipcMain } from 'electron'
import { HIBERNATE_HELD, type HibernateOutcome } from '../../../shared/agents/agentWork'
import type {
  PaneActivity,
  PromptContext,
  PromptContextRequest,
  PtyAttachResult,
  PtySpawnOptions,
  TerminalStateSnapshot,
} from '../../../shared/terminal/ptyApi'
import type { AgentRunningPanes } from '../../agents/agentRunning'
import { backgroundWork, type ReportedAgentWork, readProcessTable } from '../../agents/agentWork'
import { getByPaneId } from '../../control/idRegistry'
import type { OpenWaits } from '../../files/openWaits'
import { humanInputSource } from '../../panes/paneInput'
import type { PaneWaking } from '../../panes/paneWaking'
import { wakeReason } from '../../panes/wakeReason'
import type { KeptShells } from '../../tmux/keptShells'
import { registerPathCompletionIpc } from '../pathCompletion'
import { KubeContextReader, NodeVersionResolver, promptContext } from '../promptContext'
import { ExecutableIndex, readShellState, registerCommandNamesIpc } from '../shellCommands'
import { registerShellHistoryIpc, ShellHistoryFiles } from '../shellHistory'
import type { PtyAttach } from './ptyAttach'
import type { PtyIo } from './ptyIo'
import { holdsLocalPrompt, type PtyQueries } from './ptyQueries'
import type { PtyEntry } from './ptyRegistry'
import { releasePty, resizeFromDesktop } from './ptySize'
import type { PtyStop } from './ptyStop'

interface PtyIpcDeps {
  attachPty: PtyAttach['attachPty']
  ptys: Map<string, PtyEntry>
  terminalState: Map<string, TerminalStateSnapshot>
  keptShells: KeptShells
  openWaits: OpenWaits
  agentWork: ReportedAgentWork
  agentRunning: AgentRunningPanes
  paneWaking: PaneWaking
  paneStartErrors: Map<string, string>
  hibernatePty: PtyStop['hibernatePty']
  hibernateHeld: (paneId: string, writes: number) => boolean
  killPty: PtyStop['killPty']
  releasePtyFlow: PtyIo['releasePtyFlow']
  paneActivity: PtyQueries['paneActivity']
  sandboxReadRules: PtyQueries['sandboxReadRules']
  readSettingsFile: () => { behavior?: { historySuggestions?: unknown } }
}

export function registerPtyIpc(deps: PtyIpcDeps): void {
  registerPtyLifecycleIpc(deps)
  registerPtyControlIpc(deps)
  registerPtyQueryIpc(deps)
}

function registerPtyLifecycleIpc({
  attachPty,
  ptys,
  keptShells,
  agentWork,
  hibernatePty,
  hibernateHeld,
  killPty,
  paneStartErrors,
}: PtyIpcDeps): void {
  const attaching = new Map<string, Promise<PtyAttachResult>>()
  ipcMain.handle('pty:attach', async (e, paneId: string, opts: PtySpawnOptions) => {
    const previous = attaching.get(paneId)
    if (previous) await previous.catch(() => undefined)
    const pending = attachPty(e, paneId, opts)
    attaching.set(paneId, pending)
    try {
      const result = await pending
      if (!result.created && !opts.attachOnly && !ptys.has(paneId)) {
        paneStartErrors.set(paneId, 'the shell did not start')
      } else paneStartErrors.delete(paneId)
      return result
    } catch (error) {
      paneStartErrors.set(paneId, error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      if (attaching.get(paneId) === pending) attaching.delete(paneId)
    }
  })

  ipcMain.on('pty:detach', (e, paneId: string) => {
    const entry = ptys.get(paneId)
    if (!entry) return
    const subId = String(e.sender.id)
    entry.subs.delete(subId)
    entry.session.removeSubscriber(subId)
  })

  ipcMain.handle('pty:hibernate', async (_e, raw: string): Promise<HibernateOutcome> => {
    const paneId = String(raw)
    const entry = ptys.get(paneId)
    if (!entry) return 'no-terminal'
    const busy = backgroundWork(agentWork.reason(paneId), await readProcessTable(), entry.pty.pid)
    if (busy) return busy
    if (ptys.get(paneId) !== entry) return 'no-terminal'
    if (hibernateHeld(paneId, entry.input.writes)) return HIBERNATE_HELD
    return hibernatePty(paneId) ? 'hibernated' : 'no-terminal'
  })

  ipcMain.handle('pty:kept-waiting', async (): Promise<string[]> => {
    await keptShells.ready
    return keptShells.waitingPaneIds()
  })

  ipcMain.handle('pty:restart', (e, paneId: string): boolean => {
    const entry = ptys.get(String(paneId))
    if (!entry?.subs.has(String(e.sender.id))) return false
    killPty(String(paneId), 'restart')
    return true
  })
}

function registerPtyControlIpc({
  ptys,
  openWaits,
  agentRunning,
  paneWaking,
  releasePtyFlow,
}: PtyIpcDeps): void {
  ipcMain.on('pty:agent-running', (e, paneId: unknown, running: unknown) => {
    if (typeof paneId !== 'string' || typeof running !== 'boolean') return
    const attached = ptys.get(paneId)?.subs.has(String(e.sender.id)) === true
    agentRunning.report(paneId, running, attached)
  })

  ipcMain.on('pty:ack', (e, paneId: unknown, chars: unknown) => {
    if (typeof paneId !== 'string' || typeof chars !== 'number') return
    ptys.get(paneId)?.flow.ack(String(e.sender.id), chars)
  })
  app.on('render-process-gone', (_e, contents) => {
    releasePtyFlow(String(contents.id))
    openWaits.windowGone(String(contents.id))
  })

  ipcMain.on('pty:waking', (e, paneId: unknown, waking: unknown, reason: unknown) => {
    if (typeof paneId !== 'string' || typeof waking !== 'boolean') return
    if (getByPaneId(paneId)?.windowId !== String(e.sender.id)) return
    if (waking) paneWaking.start(paneId)
    else paneWaking.end(paneId, 'failed', wakeReason(reason))
  })

  ipcMain.on('pty:write', (e, paneId: string, data: string, source?: unknown) => {
    const entry = ptys.get(paneId)
    if (!entry?.session.canWrite(String(e.sender.id))) return
    const human = humanInputSource(source)
    entry.input.note(data, human)
    if (human !== null) releasePty(paneId, entry)
    entry.pty.write(data)
  })
  ipcMain.on('pty:release-hold', (e, paneId: unknown) => {
    const entry = typeof paneId === 'string' ? ptys.get(paneId) : undefined
    if (entry?.session.canWrite(String(e.sender.id))) releasePty(paneId as string, entry)
  })
  ipcMain.on('pty:retry-link', (e, paneId: unknown) => {
    const entry = typeof paneId === 'string' ? ptys.get(paneId) : undefined
    if (entry?.session.canWrite(String(e.sender.id))) entry.kept?.retryLink()
  })
  ipcMain.on('pty:resize', (e, paneId: string, cols: number, rows: number) => {
    const entry = ptys.get(paneId)
    if (!entry?.subs.has(String(e.sender.id)) || entry.keepAlive) return
    resizeFromDesktop(paneId, entry, cols, rows)
  })
}

function registerPtyQueryIpc({
  ptys,
  terminalState,
  paneActivity,
  sandboxReadRules,
  readSettingsFile,
}: PtyIpcDeps): void {
  const executables = new ExecutableIndex()
  const promptSources = { node: new NodeVersionResolver(), kube: new KubeContextReader() }
  const shellHistoryFiles = new ShellHistoryFiles()
  ipcMain.handle('pty:foreground', (e, paneId: string): string | null => {
    const entry = ptys.get(paneId)
    if (!entry?.subs.has(String(e.sender.id))) return null
    try {
      const name = entry.pty.process
      return typeof name === 'string' && name ? (name.split('/').pop() ?? null) : null
    } catch {
      return null
    }
  })
  ipcMain.handle('pty:activity', (e, paneId: string): PaneActivity | null => {
    const entry = ptys.get(String(paneId))
    if (!entry?.subs.has(String(e.sender.id))) return null
    return paneActivity(entry)
  })
  const promptPane = (paneId: string) => {
    const entry = ptys.get(paneId)
    if (!entry) return null
    return {
      owners: entry.subs,
      localPrompt: holdsLocalPrompt(entry),
      shell: entry.shell,
      stateFile: entry.stateFile,
      spawnPath: entry.spawnPath,
      rules: sandboxReadRules(entry),
    }
  }
  registerCommandNamesIpc(executables, promptPane)
  registerShellHistoryIpc({
    enabled: () => readSettingsFile().behavior?.historySuggestions !== false,
    files: shellHistoryFiles,
    pane: promptPane,
  })
  ipcMain.handle('pty:local-prompt', (e, paneId: string): boolean => {
    const entry = ptys.get(paneId)
    return entry?.subs.has(String(e.sender.id)) === true && holdsLocalPrompt(entry)
  })
  registerPathCompletionIpc(promptPane)
  ipcMain.handle(
    'pty:prompt-context',
    async (e, paneId: string, want: PromptContextRequest): Promise<PromptContext | null> => {
      const entry = ptys.get(paneId)
      if (!entry?.subs.has(String(e.sender.id))) return null
      const state = await readShellState(entry.stateFile)
      return promptContext(
        state,
        entry.spawnPath,
        terminalState.get(paneId)?.cwd,
        { node: want?.node === true, kube: want?.kube === true },
        promptSources,
      )
    },
  )
}
