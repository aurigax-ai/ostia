import {
  type ExtensionCaller,
  type ExtensionResult,
  failure,
  namedArgs,
  type OstiaExtension,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import { isRecordId } from './hookEvent'
import type { Journal } from './journal'
import type { OpenListing } from './openListing'
import type { RememberStore } from './remember'
import { rememberView } from './rememberView'
import type { PanelSnapshot } from './snapshot'
import { panelModel } from './view'

export const SHOW_ACTIVITY = 'showActivity'

interface PanelCommandsDeps {
  ext: OstiaExtension
  journal: Journal
  hostJournal: Journal
  remembered: RememberStore
  state: { showActivity: boolean; rememberDays: number }
  settingsLoaded: Promise<void>
  listing: OpenListing
  changed: () => void
}

export type PanelCommand = (args: unknown, caller: ExtensionCaller) => Promise<ExtensionResult>

export function activityPanelCommands(deps: PanelCommandsDeps): Record<string, PanelCommand> {
  const { ext, journal, hostJournal, remembered, state, settingsLoaded, listing, changed } = deps
  const snapshot = async (args: unknown, caller: ExtensionCaller): Promise<ExtensionResult> => {
    await settingsLoaded
    const workspaceId = caller.workspaceId ?? ''
    const listed = await listing.read(workspaceId)
    if (!listed) return failure('unavailable')
    const workspace = listed.workspaces.find((w) => w.workspaceId === workspaceId)
    const rev = [
      state.showActivity ? 1 : 0,
      workspace ? 1 : 0,
      listed.rev,
      journal.revision(workspaceId),
      hostJournal.revision(workspaceId),
      remembered.revision(workspaceId),
      state.rememberDays,
    ].join('.')
    if (namedArgs(args).rev === rev) {
      const unchanged: PanelSnapshot = { unchanged: true }
      return ok(undefined, unchanged)
    }
    const model: PanelSnapshot = {
      rev,
      ...panelModel({
        showActivity: state.showActivity,
        workspace,
        panes: listed.panes,
        events: (id) => [...journal.events(id), ...hostJournal.events(id)],
      }),
      remember: rememberView(
        remembered.items(workspaceId),
        listed.panes,
        new Set(),
        state.rememberDays,
      ),
    }
    return ok(undefined, model)
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
    rememberState: async (args: unknown, caller: ExtensionCaller) => {
      const { id, state: next } = namedArgs(args)
      const workspaceId = caller.workspaceId
      if (!workspaceId || !isRecordId(id)) return failure('invalid-args')
      if (next !== 'open' && next !== 'done' && next !== 'archived') return failure('invalid-args')
      const item = remembered.find(workspaceId, id)
      if (!item) return failure('unknown-entry')
      if (next === 'open' && item.state === 'open') return ok()
      remembered.setState(workspaceId, id, next, Date.now())
      changed()
      return ok()
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
