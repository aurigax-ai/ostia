import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import {
  EXTENSION_EVENT_TYPES,
  type ExtensionEventPayloads,
  type ExtensionEventType,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { parseCommand } from '@aurigax-ai/ostia-extension-sdk/manifest/manifestContributions'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { hasCap } from '../approvals/capabilityStore'
import type { PaneIdentity } from '../control/idRegistry'
import type { ExtensionHostDeps } from './extensionHostDeps'
import type { ExtensionRuns } from './extensionRuns'
import { fail } from './extensionRuntime'
import type { Runtime } from './extensionRuntime'

const EVENT_CAPABILITIES: Partial<Record<ExtensionEventType, Capability>> = {
  notification: 'notify',
  'bus.message': 'read-bus',
}

export interface ExtensionEventsHost {
  deps: Pick<ExtensionHostDeps, 'launches'>
  runtimes: ReadonlyMap<string, Runtime>
  runs: Pick<ExtensionRuns, 'settleTerminalWait'>
  runtimeOf(identity: PaneIdentity, conn: MessageConnection): Runtime
  changed(rt?: Runtime): void
}

export class ExtensionEvents {
  constructor(private readonly host: ExtensionEventsHost) {}

  workspaceClosed(workspaceId: string): void {
    for (const rt of this.host.runtimes.values()) rt.callerWorkspaces.delete(workspaceId)
    this.emitEvent('workspace.closed', { workspaceId })
  }

  emitEvent<T extends ExtensionEventType>(type: T, payload: ExtensionEventPayloads[T]): void {
    this.host.runs.settleTerminalWait(type, payload)
    for (const rt of this.host.runtimes.values()) {
      if (!rt.conn || !rt.subscriptions.has(type)) continue
      if (type === 'bus.message' && !(rt.identity && hasCap(rt.identity.externalId, 'read-bus'))) {
        continue
      }
      void rt.conn.sendNotification('ext.event', { type, payload }).catch(() => {})
    }
  }

  registerCommands(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const raw = (params as { commands?: unknown })?.commands
    if (!Array.isArray(raw)) return fail('invalid-params', 'commands must be an array')
    const declared = rt.ext.manifest.contributes.commands
    for (const [i, entry] of raw.entries()) {
      const id = typeof entry === 'string' ? entry : (entry as { id?: unknown })?.id
      const known = declared.find((c) => c.id === id)
      if (known) {
        rt.ready.set(known.id, known)
        continue
      }
      if (typeof entry === 'string') return fail('undeclared-command', `'${entry}' needs a title`)
      const parsed = parseCommand(entry, i)
      if (typeof parsed === 'string') return fail('invalid-command', parsed)
      rt.ready.set(parsed.id, parsed)
    }
    this.host.changed(rt)
    return { ok: true, commands: [...rt.ready.keys()] }
  }

  subscribe(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const events = (params as { events?: unknown })?.events
    if (!Array.isArray(events)) return fail('invalid-params', 'events must be an array')
    for (const type of events) {
      if (!EXTENSION_EVENT_TYPES.includes(type as ExtensionEventType)) {
        return fail('unknown-event', String(type))
      }
      const cap: Capability = EVENT_CAPABILITIES[type as ExtensionEventType] ?? 'read-board'
      if (!hasCap(identity.externalId, cap)) return fail('needs-elevation', cap)
    }
    for (const type of events) rt.subscriptions.add(type as ExtensionEventType)
    return { ok: true, events: [...rt.subscriptions] }
  }

  startWithWindow(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const on = (params as { on?: unknown } | null)?.on
    if (typeof on !== 'boolean') return fail('invalid-params', 'on must be a boolean')
    this.host.deps.launches?.set(rt.ext.manifest.id, on)
    return { ok: true }
  }
}
