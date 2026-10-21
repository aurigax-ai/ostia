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
import { type Limits, limitsDigest, type PanelSnapshot, panelModel } from './view'

export const SHOW_ACTIVITY = 'showActivity'

interface PanelCommandsDeps {
  ext: OstiaExtension
  journal: Journal
  hostJournal: Journal
  state: { showActivity: boolean }
  settingsLoaded: Promise<void>
  listing: OpenListing
  changed: () => void
}

const LIMITS_MAX_KEYS = 500

export function parseLimits(raw: unknown): Limits {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const limits: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw).slice(0, LIMITS_MAX_KEYS)) {
    if (Number.isSafeInteger(value) && (value as number) > 0) limits[key] = value as number
  }
  return limits
}

export type PanelCommand = (args: unknown, caller: ExtensionCaller) => Promise<ExtensionResult>

export function activityPanelCommands(deps: PanelCommandsDeps): Record<string, PanelCommand> {
  const { ext, journal, hostJournal, state, settingsLoaded, listing, changed } = deps
  const snapshot = async (args: unknown, caller: ExtensionCaller): Promise<ExtensionResult> => {
    await settingsLoaded
    const workspaceId = caller.workspaceId ?? ''
    const limits = parseLimits(namedArgs(args).limits)
    const listed = await listing.read(workspaceId)
    if (!listed) return failure('unavailable')
    const workspace = listed.workspaces.find((w) => w.workspaceId === workspaceId)
    const rev = [
      state.showActivity ? 1 : 0,
      workspace ? 1 : 0,
      listed.rev,
      journal.revision(workspaceId),
      hostJournal.revision(workspaceId),
      limitsDigest(limits),
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
        limits,
        events: (id) => [...journal.events(id), ...hostJournal.events(id)],
      }),
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
