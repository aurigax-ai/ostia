import {
  type ExtensionCaller,
  type ExtensionResult,
  type OstiaExtension,
  failure,
  namedArgs,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import { isRecordId } from './hookEvent'
import type { Journal } from './journal'
import { type OpenPane, type OpenWorkspace, panelModel } from './view'

export const SHOW_ACTIVITY = 'showActivity'

function listedPanes(raw: unknown): OpenPane[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is OpenPane => typeof p?.paneId === 'string')
    .map((p) =>
      typeof p.agentState === 'string'
        ? { paneId: p.paneId, agentState: p.agentState }
        : { paneId: p.paneId },
    )
}

interface PanelCommandsDeps {
  ext: OstiaExtension
  journal: Journal
  hostJournal: Journal
  state: { showActivity: boolean }
  settingsLoaded: Promise<void>
  refreshWorkspaces: () => Promise<OpenWorkspace[] | null>
  changed: () => void
}

export type PanelCommand = (args: unknown, caller: ExtensionCaller) => Promise<ExtensionResult>

export function activityPanelCommands(deps: PanelCommandsDeps): Record<string, PanelCommand> {
  const { ext, journal, hostJournal, state, settingsLoaded, refreshWorkspaces, changed } = deps
  const snapshot = async (_args: unknown, caller: ExtensionCaller): Promise<ExtensionResult> => {
    await settingsLoaded
    const open = await refreshWorkspaces()
    if (!open) return failure('unavailable')
    let panes: OpenPane[]
    try {
      panes = listedPanes(await ext.listPanes())
    } catch {
      return failure('unavailable')
    }
    return ok(
      undefined,
      panelModel({
        showActivity: state.showActivity,
        workspace: open.find((w) => w.workspaceId === caller.workspaceId),
        panes,
        events: (workspaceId) => [
          ...journal.events(workspaceId),
          ...hostJournal.events(workspaceId),
        ],
      }),
    )
  }

  return {
    snapshot,
    setShowActivity: async (args: unknown) => {
      const value = namedArgs(args).value
      if (typeof value !== 'boolean') return failure('invalid-args')
      await settingsLoaded
      const stored = await ext.setSetting(SHOW_ACTIVITY, value)
      if (stored.ok) state.showActivity = value
      return stored
    },
    focus: async (args: unknown) => {
      const paneId = namedArgs(args).paneId
      return typeof paneId === 'string' ? ext.focusPane(paneId) : failure('invalid-args')
    },
    done: async (args: unknown) => {
      const { workspaceId, id } = namedArgs(args)
      if (typeof workspaceId !== 'string' || !isRecordId(id)) return failure('invalid-args')
      const done = journal.markDone(workspaceId, id, Date.now())
      if (!done) return failure('unknown-entry')
      changed()
      return ok()
    },
  }
}
