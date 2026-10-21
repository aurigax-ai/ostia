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
import { parkedView } from './parkedView'
import type { RememberStore } from './remember'
import { rememberView } from './rememberView'
import type { PanelSnapshot } from './snapshot'
import { type Limits, limitsDigest, panelModel } from './view'

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
  const { ext, journal, hostJournal, remembered, state, settingsLoaded, listing, changed } = deps
  const snapshot = async (args: unknown, caller: ExtensionCaller): Promise<ExtensionResult> => {
    await settingsLoaded
    const workspaceId = caller.workspaceId ?? ''
    const limits = parseLimits(namedArgs(args).limits)
    const listed = await listing.read(workspaceId)
    if (!listed) return failure('unavailable')
    const workspace = listed.workspaces.find((w) => w.workspaceId === workspaceId)
    const parkedList = await ext.parkedList(workspaceId).catch(() => null)
    const parkedItems = parkedList?.ok ? parkedList.items : []
    const rev = [
      state.showActivity ? 1 : 0,
      workspace ? 1 : 0,
      listed.rev,
      journal.revision(workspaceId),
      hostJournal.revision(workspaceId),
      remembered.revision(workspaceId),
      state.rememberDays,
      parkedItems.map((item) => `${item.id}${item.parkedAt}`).join(','),
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
      remember: rememberView(
        remembered.items(workspaceId),
        listed.panes,
        new Set(parkedItems.map((item) => item.sessionId)),
        state.rememberDays,
      ),
      parked: parkedView(parkedItems, remembered.openBySession(workspaceId)),
    }
    return ok(undefined, model)
  }

  const parkedAct = async (
    args: unknown,
    caller: ExtensionCaller,
    act: 'resume' | 'forget',
  ): Promise<ExtensionResult> => {
    const { id } = namedArgs(args)
    const workspaceId = caller.workspaceId
    if (!workspaceId || typeof id !== 'string') return failure('invalid-args')
    const listed = await ext.parkedList(workspaceId).catch(() => null)
    if (!listed?.ok || !listed.items.some((item) => item.id === id)) {
      return failure('unknown-parked')
    }
    const res = await (act === 'resume' ? ext.parkedResume(id) : ext.parkedForget(id))
    changed()
    return res.ok ? ok() : failure(res.error, res.message)
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
    parkedResume: (args: unknown, caller: ExtensionCaller) => parkedAct(args, caller, 'resume'),
    parkedForget: (args: unknown, caller: ExtensionCaller) => parkedAct(args, caller, 'forget'),
  }
}
