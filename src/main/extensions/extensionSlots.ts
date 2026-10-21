import {
  EXTENSION_ICONS,
  type ExtensionChip,
  type ExtensionChipContribution,
  type ExtensionCommandContribution,
  type ExtensionIcon,
  type ExtensionResult,
  type ExtensionSidebarItem,
  INBOX_ACTION_EVENT,
  INBOX_ITEMS_MAX,
  INBOX_TEXT_MAX,
  type InboxActionEvent,
  type InboxEntry,
  type InboxItem,
  PANE_CHIP_ITEMS_MAX,
  PANE_CHIP_TEXT_MAX,
  PANE_CHIP_TOOLTIP_MAX,
  PANEL_TOOLBAR_BACK_MAX,
  type PaneChip,
  type PanelToolbarEntry,
  type PanelToolbarState,
  paneChipItems,
  SIDEBAR_BADGE_PATTERN,
  SIDEBAR_KINDS,
  SIDEBAR_TONES,
  type SidebarKind,
  type SidebarTone,
  sidebarItemUrl,
  type WorkspaceChip,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import type { ExtensionHostDeps } from './extensionHostDeps'
import { fail, type Runtime } from './extensionRuntime'

const MAX_SIDEBAR_ITEMS = 32

const MAX_PANEL_TOOLBARS = 32

const SIDEBAR_TEXT_MAX = 80

const MAX_INBOX_ENTRIES = 32

const INBOX_ID_PATTERN = /^[a-z2-7]{10}$/

export interface ExtensionSlotsHost {
  deps: Pick<
    ExtensionHostDeps,
    'broadcast' | 'publishWorkspaceChips' | 'publishInbox' | 'workDirForWorkspace'
  >
  runtimeOf(identity: PaneIdentity, conn: MessageConnection): Runtime
  commandsOf(rt: Runtime): ExtensionCommandContribution[]
  sendEvent(extId: string, type: string, payload: unknown): boolean
}

export class ExtensionSlots {
  constructor(private readonly host: ExtensionSlotsHost) {}

  private sidebar = new Map<string, ExtensionSidebarItem>()

  private chips = new Map<string, PaneChip>()

  private workspaceChipSlots = new Map<string, WorkspaceChip>()

  private panelToolbars = new Map<string, PanelToolbarEntry>()

  private inbox = new Map<string, InboxEntry>()

  sidebarItems(): ExtensionSidebarItem[] {
    return [...this.sidebar.values()]
  }

  paneChips(): PaneChip[] {
    return [...this.chips.values()]
  }

  private chipsChanged(): void {
    this.host.deps.broadcast('extensions:chips', this.paneChips())
  }

  clearChipsWhere(match: (chip: PaneChip) => boolean): void {
    let removed = false
    for (const [slot, chip] of this.chips) {
      if (match(chip)) {
        this.chips.delete(slot)
        removed = true
      }
    }
    if (removed) this.chipsChanged()
  }

  clearPaneChips(rendererPaneId: string): void {
    this.clearChipsWhere((chip) => chip.paneId === rendererPaneId)
  }

  workspaceChips(): WorkspaceChip[] {
    return [...this.workspaceChipSlots.values()]
  }

  publishWorkspaceChips(): void {
    this.host.deps.publishWorkspaceChips?.(this.workspaceChips())
  }

  clearWorkspaceChipsWhere(match: (chip: WorkspaceChip) => boolean): void {
    let removed = false
    for (const [slot, chip] of this.workspaceChipSlots) {
      if (match(chip)) {
        this.workspaceChipSlots.delete(slot)
        removed = true
      }
    }
    if (removed) this.publishWorkspaceChips()
  }

  clearWorkspaceChips(workspaceId: string): void {
    this.clearWorkspaceChipsWhere((chip) => chip.workspaceId === workspaceId)
  }

  inboxEntries(): InboxEntry[] {
    return [...this.inbox.values()]
  }

  holdsInboxItem(extId: string, workspaceId: string, id: string): boolean {
    return (
      this.inbox.get(`${extId}\u0000${workspaceId}`)?.items.some((item) => item.id === id) === true
    )
  }

  inboxAction(extId: string, workspaceId: string, id: string): boolean {
    if (!this.holdsInboxItem(extId, workspaceId, id)) return false
    const payload: InboxActionEvent = { workspaceId, id, action: 'done' }
    return this.host.sendEvent(extId, INBOX_ACTION_EVENT, payload)
  }

  private inboxChanged(): void {
    this.host.deps.publishInbox?.(this.inboxEntries())
  }

  clearInboxWhere(match: (entry: InboxEntry) => boolean): void {
    let removed = false
    for (const [slot, entry] of this.inbox) {
      if (match(entry)) {
        this.inbox.delete(slot)
        removed = true
      }
    }
    if (removed) this.inboxChanged()
  }

  setInboxItems(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const extId = rt.ext.manifest.id
    if (!rt.ext.builtin) return fail('builtin-only', 'only a built-in extension has an inbox')
    const tabs = rt.ext.manifest.contributes.panel?.toolbar?.tabs ?? []
    if (!tabs.some((tab) => tab.surface === 'inbox')) {
      return fail('not-contributed', 'manifest does not contribute an inbox tab')
    }
    const p = (params ?? {}) as Record<string, unknown>
    const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : ''
    if (!workspaceId || this.host.deps.workDirForWorkspace(workspaceId) === undefined) {
      return fail('unknown-workspace', 'workspaceId is not an open workspace')
    }
    if (!rt.callerWorkspaces.has(workspaceId)) {
      return fail('no-caller', 'you have no caller in that workspace')
    }
    if (!Array.isArray(p.items) || p.items.length > INBOX_ITEMS_MAX) {
      return fail('invalid-params', `items must be an array of at most ${INBOX_ITEMS_MAX}`)
    }
    const items: InboxItem[] = []
    for (const raw of p.items) {
      const item = inboxItemOf(raw)
      if (!item) return fail('invalid-params', 'an item needs an id, text and a time')
      if (items.some((known) => known.id === item.id)) {
        return fail('invalid-params', `duplicate item ${item.id}`)
      }
      if (item.paneId !== undefined) {
        const found = resolveExternal(item.paneId)
        if (found?.kind === 'pane' && found.workspaceId === workspaceId) item.paneId = found.paneId
        else delete item.paneId
      }
      items.push(item)
    }
    const slot = `${extId}\u0000${workspaceId}`
    if (items.length === 0) {
      if (this.inbox.delete(slot)) this.inboxChanged()
      return { ok: true }
    }
    const count = [...this.inbox.values()].filter((e) => e.extId === extId).length
    if (!this.inbox.has(slot) && count >= MAX_INBOX_ENTRIES) return fail('too-many-items')
    this.inbox.set(slot, { extId, workspaceId, items })
    this.inboxChanged()
    return { ok: true }
  }

  panelToolbarEntries(): PanelToolbarEntry[] {
    return [...this.panelToolbars.values()]
  }

  private panelToolbarsChanged(): void {
    this.host.deps.broadcast('extensions:panel-toolbar', this.panelToolbarEntries())
  }

  clearPanelToolbarsWhere(match: (entry: PanelToolbarEntry) => boolean): void {
    let removed = false
    for (const [slot, entry] of this.panelToolbars) {
      if (match(entry)) {
        this.panelToolbars.delete(slot)
        removed = true
      }
    }
    if (removed) this.panelToolbarsChanged()
  }

  setPanelToolbar(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const extId = rt.ext.manifest.id
    const toolbar = rt.ext.manifest.contributes.panel?.toolbar
    if (!rt.ext.manifest.contributes.panel) {
      return fail('not-contributed', 'manifest does not contribute a panel')
    }
    const p = (params ?? {}) as Record<string, unknown>
    const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : ''
    if (!workspaceId || this.host.deps.workDirForWorkspace(workspaceId) === undefined) {
      return fail('unknown-workspace', 'workspaceId is not an open workspace')
    }
    if (!rt.callerWorkspaces.has(workspaceId)) {
      return fail('no-caller', 'your panel has not been opened in that workspace')
    }
    const tabs = new Set((toolbar?.tabs ?? []).map((t) => t.id))
    const actions = new Set((toolbar?.actions ?? []).map((a) => a.id))
    const state: PanelToolbarState = {}
    if (p.tab !== undefined) {
      if (typeof p.tab !== 'string' || !tabs.has(p.tab)) {
        return fail('invalid-params', 'tab must be one of your declared tabs')
      }
      state.tab = p.tab
    }
    if (p.back !== undefined) {
      const back = typeof p.back === 'string' ? p.back.trim().slice(0, PANEL_TOOLBAR_BACK_MAX) : ''
      if (!back) return fail('invalid-params', 'back must be a non-empty string')
      state.back = back
    }
    if (p.badges !== undefined) {
      if (!isRecord(p.badges)) return fail('invalid-params', 'badges must be an object')
      const entries = Object.entries(p.badges)
      const ok = entries.every(
        ([id, n]) => (tabs.has(id) || actions.has(id)) && Number.isInteger(n) && (n as number) > 0,
      )
      if (!ok) return fail('invalid-params', 'badges must map declared ids to positive integers')
      state.badges = Object.fromEntries(entries.map(([id, n]) => [id, Math.min(n as number, 999)]))
    }
    for (const field of ['disabled', 'hidden'] as const) {
      const value = p[field]
      if (value === undefined) continue
      const ids = Array.isArray(value) ? value : null
      if (!ids?.every((id) => typeof id === 'string' && (tabs.has(id) || actions.has(id)))) {
        return fail('invalid-params', `${field} must list declared ids`)
      }
      state[field] = ids as string[]
    }
    const slot = `${extId}\u0000${workspaceId}`
    if (Object.keys(state).length === 0) {
      if (this.panelToolbars.delete(slot)) this.panelToolbarsChanged()
      return { ok: true }
    }
    const count = [...this.panelToolbars.values()].filter((e) => e.extId === extId).length
    if (!this.panelToolbars.has(slot) && count >= MAX_PANEL_TOOLBARS) return fail('too-many-items')
    this.panelToolbars.set(slot, { extId, workspaceId, state })
    this.panelToolbarsChanged()
    return { ok: true }
  }

  private sidebarChanged(): void {
    this.host.deps.broadcast('extensions:sidebar', this.sidebarItems())
  }

  clearSidebarOf(extId: string): void {
    let removed = false
    for (const [key, item] of this.sidebar) {
      if (item.extId === extId) {
        this.sidebar.delete(key)
        removed = true
      }
    }
    if (removed) this.sidebarChanged()
  }

  setSidebarItem(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const extId = rt.ext.manifest.id
    if (!rt.ext.manifest.contributes.sidebarItems) {
      return fail('not-contributed', 'manifest does not contribute sidebarItems')
    }
    const p = (params ?? {}) as Record<string, unknown>
    const key = typeof p.key === 'string' && p.key ? p.key.slice(0, 40) : 'default'
    const workspaceId =
      typeof p.workspaceId === 'string' && p.workspaceId ? p.workspaceId : undefined
    const slot = `${extId}\u0000${workspaceId ?? ''}\u0000${key}`
    const text = typeof p.text === 'string' ? p.text.trim().slice(0, SIDEBAR_TEXT_MAX) : ''
    if (!text) {
      if (this.sidebar.delete(slot)) this.sidebarChanged()
      return { ok: true }
    }
    const count = [...this.sidebar.values()].filter((i) => i.extId === extId).length
    if (!this.sidebar.has(slot) && count >= MAX_SIDEBAR_ITEMS) return fail('too-many-items')
    const tone = SIDEBAR_TONES.includes(p.tone as SidebarTone) ? (p.tone as SidebarTone) : 'neutral'
    const kind = SIDEBAR_KINDS.includes(p.kind as SidebarKind) ? (p.kind as SidebarKind) : 'live'
    const item: ExtensionSidebarItem = { extId, key, text, tone, kind }
    if (workspaceId) item.workspaceId = workspaceId
    if (EXTENSION_ICONS.includes(p.icon as ExtensionIcon)) item.icon = p.icon as ExtensionIcon
    if (typeof p.badge === 'string' && SIDEBAR_BADGE_PATTERN.test(p.badge)) item.badge = p.badge
    const url = sidebarItemUrl(p.url)
    if (url) item.url = url
    this.sidebar.set(slot, item)
    this.sidebarChanged()
    return { ok: true }
  }

  private chipValue(
    rt: Runtime,
    declared: ExtensionChipContribution,
    p: Record<string, unknown>,
  ): ExtensionChip | null | ExtensionResult {
    const text = typeof p.text === 'string' ? p.text.trim().slice(0, PANE_CHIP_TEXT_MAX) : ''
    if (!text) return null
    const tone = SIDEBAR_TONES.includes(p.tone as SidebarTone) ? (p.tone as SidebarTone) : 'neutral'
    const chip: ExtensionChip = { extId: rt.ext.manifest.id, id: declared.id, text, tone }
    if (typeof p.tooltip === 'string' && p.tooltip.trim()) {
      chip.tooltip = p.tooltip.trim().slice(0, PANE_CHIP_TOOLTIP_MAX)
    }
    if ([p.command, p.url, p.items].filter((v) => v !== undefined).length > 1) {
      return fail('invalid-params', 'a chip has at most one of a command, a url or items')
    }
    if (p.icon !== undefined) {
      if (!EXTENSION_ICONS.includes(p.icon as ExtensionIcon)) {
        return fail('invalid-params', `icon must be one of ${EXTENSION_ICONS.join(', ')}`)
      }
      chip.icon = p.icon as ExtensionIcon
    }
    if (p.items !== undefined) {
      const items = paneChipItems(p.items)
      if (!items) {
        return fail(
          'invalid-params',
          `items must be 1-${PANE_CHIP_ITEMS_MAX} entries of {text, url?} with http(s) urls`,
        )
      }
      chip.items = items
    }
    if (p.command !== undefined) {
      const command = this.host.commandsOf(rt).find((c) => c.id === p.command && c.palette)
      if (!command) return fail('invalid-params', 'command must be one of your palette commands')
      chip.command = command.id
    }
    if (p.url !== undefined) {
      const url = sidebarItemUrl(p.url)
      if (!url) return fail('invalid-params', 'url must be http(s)')
      chip.url = url
    }
    return chip
  }

  setPaneChip(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = (params ?? {}) as Record<string, unknown>
    const declared = rt.ext.manifest.contributes.paneChips.find((c) => c.id === p.id)
    if (!declared) return fail('not-contributed', `no pane chip '${String(p.id)}' in manifest`)
    const pane = typeof p.paneId === 'string' ? resolveExternal(p.paneId) : undefined
    if (pane?.kind !== 'pane') return fail('unknown-pane', 'paneId is not a pane')
    const slot = `${rt.ext.manifest.id}\u0000${pane.paneId}\u0000${declared.id}`
    const value = this.chipValue(rt, declared, p)
    if (value === null) {
      if (this.chips.delete(slot)) this.chipsChanged()
      return { ok: true }
    }
    if ('ok' in value) return value
    this.chips.set(slot, { ...value, paneId: pane.paneId })
    this.chipsChanged()
    return { ok: true }
  }

  clearPaneChip(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const p = (params ?? {}) as Record<string, unknown>
    return this.setPaneChip(identity, conn, { paneId: p.paneId, id: p.id, text: '' })
  }

  setWorkspaceChip(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = (params ?? {}) as Record<string, unknown>
    const declared = rt.ext.manifest.contributes.workspaceChips.find((c) => c.id === p.id)
    if (!declared) {
      return fail('not-contributed', `no workspace chip '${String(p.id)}' in manifest`)
    }
    const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : ''
    if (!workspaceId || this.host.deps.workDirForWorkspace(workspaceId) === undefined) {
      return fail('unknown-workspace', 'workspaceId is not an open workspace')
    }
    const slot = `${rt.ext.manifest.id}\u0000${workspaceId}\u0000${declared.id}`
    const value = this.chipValue(rt, declared, p)
    if (value === null) {
      if (this.workspaceChipSlots.delete(slot)) this.publishWorkspaceChips()
      return { ok: true }
    }
    if ('ok' in value) return value
    this.workspaceChipSlots.set(slot, { ...value, workspaceId })
    this.publishWorkspaceChips()
    return { ok: true }
  }

  clearWorkspaceChip(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const p = (params ?? {}) as Record<string, unknown>
    return this.setWorkspaceChip(identity, conn, { workspaceId: p.workspaceId, id: p.id, text: '' })
  }
}

function inboxItemOf(raw: unknown): InboxItem | null {
  if (!isRecord(raw)) return null
  const { id, text, paneId, at } = raw
  if (typeof id !== 'string' || !INBOX_ID_PATTERN.test(id)) return null
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  if (clean === '' || typeof at !== 'number' || !Number.isFinite(at)) return null
  const item: InboxItem = { id, text: [...clean].slice(0, INBOX_TEXT_MAX).join(''), at }
  if (typeof paneId === 'string' && paneId !== '') item.paneId = paneId
  return item
}
