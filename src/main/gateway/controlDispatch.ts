import type { Capability } from '../../shared/capabilities'
import type {
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  TerminalStateSnapshot,
} from '../../shared/types'
import { resolveExternal } from '../idRegistry'
import type { PaneEntry, WorkspaceEntry } from '../paneList'

export interface GatewayControlDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  listCommandsFor: (windowId: string) => CommandDescriptor[]
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  listPanes: () => Promise<PaneEntry[]>
  listWorkspaces: () => Promise<WorkspaceEntry[]>
  primaryWindowId: () => string | undefined
  attachPhoneObserver: (
    rendererPaneId: string,
    opts: { sinceCursor?: number; role?: 'observer' | 'owner'; sendData: (data: string) => void },
  ) => { cursor: number; dropped: boolean; cols: number; rows: number; detach: () => void } | null
  ptyResize: (rendererPaneId: string, cols: number, rows: number) => void
  ptyWrite: (rendererPaneId: string, data: string) => void
}

export type RpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string; data?: unknown }

function toWireSession({ workspaceId, ...rest }: WorkspaceEntry): Record<string, unknown> {
  return { sessionId: workspaceId, ...rest }
}

function toWirePane({ workspaceId, ...rest }: PaneEntry): Record<string, unknown> {
  return { sessionId: workspaceId, ...rest }
}

function needsElevation(cap: string): RpcOutcome {
  return { ok: false, code: -32003, message: 'needs-elevation', data: { cap } }
}

function invalidParams(message: string): RpcOutcome {
  return { ok: false, code: -32602, message }
}

const PHONE_CAP_ALLOWS: Partial<Record<string, Capability[]>> = {
  read: ['read-board'],
  command: ['drive-self'],
  notify: ['notify'],
  destructive: ['destructive'],
}

function missingCapForPhone(desc: CommandDescriptor, deviceCaps: string[]): Capability | null {
  const allowed = new Set<Capability>()
  for (const phoneCap of deviceCaps) {
    for (const cap of PHONE_CAP_ALLOWS[phoneCap] ?? []) allowed.add(cap)
  }
  for (const cap of desc.capabilities) {
    if (!allowed.has(cap)) return cap
  }
  return null
}

function resolveTarget(target: unknown, primaryWindowId: string | undefined): CommandTarget | null {
  if (target === undefined || target === null) {
    return { windowId: primaryWindowId, workspaceId: '', paneId: null }
  }
  if (typeof target !== 'string' || !target) return null
  const identity = resolveExternal(target)
  if (!identity) return null
  return { windowId: identity.windowId, workspaceId: identity.workspaceId, paneId: identity.paneId }
}

export async function dispatchGatewayMethod(
  method: string,
  params: unknown,
  deviceCaps: string[],
  deps: GatewayControlDeps,
): Promise<RpcOutcome> {
  const p = (params ?? {}) as Record<string, unknown>
  const hasCap = (cap: string): boolean => deviceCaps.includes(cap)

  switch (method) {
    case 'session.list': {
      if (!hasCap('read')) return needsElevation('read')
      return { ok: true, result: { sessions: (await deps.listWorkspaces()).map(toWireSession) } }
    }

    case 'pane.list': {
      if (!hasCap('read')) return needsElevation('read')
      return { ok: true, result: { panes: (await deps.listPanes()).map(toWirePane) } }
    }

    case 'command.list': {
      if (!hasCap('read')) return needsElevation('read')
      const windowId = deps.primaryWindowId()
      return { ok: true, result: { commands: windowId ? deps.listCommandsFor(windowId) : [] } }
    }

    case 'command.exec': {
      if (!hasCap('command')) return needsElevation('command')
      const id = p.id
      if (typeof id !== 'string' || !id) return invalidParams('missing command id')
      const windowId = deps.primaryWindowId()
      const descriptors = windowId ? deps.listCommandsFor(windowId) : []
      const desc = descriptors.find((d) => d.id === id)
      if (!desc) {
        return {
          ok: true,
          result: {
            ok: false,
            error: { code: 'unknown-command', message: `unknown command '${id}'` },
          },
        }
      }
      const missing = missingCapForPhone(desc, deviceCaps)
      if (missing) return needsElevation(missing)
      const target = resolveTarget(p.target, windowId)
      if (!target) return invalidParams('unknown pane target')
      return { ok: true, result: await deps.execCommand(target, id, p.args) }
    }

    case 'pane.info': {
      if (!hasCap('read')) return needsElevation('read')
      const paneId = p.paneId
      if (typeof paneId !== 'string' || !paneId) return invalidParams('missing paneId')
      const identity = resolveExternal(paneId)
      if (!identity) return invalidParams('unknown paneId')
      const state = deps.getTerminalState(identity.paneId)
      return {
        ok: true,
        result: {
          paneId,
          generation: state?.generation ?? 0,
          cwd: state?.cwd,
          running: state?.running ?? false,
          blockCount: state?.blockCount ?? 0,
          lastExitCode: state?.lastExitCode,
        },
      }
    }

    case 'cwd.get': {
      if (!hasCap('read')) return needsElevation('read')
      const paneId = p.paneId
      if (typeof paneId !== 'string' || !paneId) return invalidParams('missing paneId')
      const identity = resolveExternal(paneId)
      const cwd = identity ? (deps.getTerminalState(identity.paneId)?.cwd ?? null) : null
      return { ok: true, result: { cwd } }
    }

    default:
      return { ok: false, code: -32601, message: `method not found: ${method}` }
  }
}
