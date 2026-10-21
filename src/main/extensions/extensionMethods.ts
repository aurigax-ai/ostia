import {
  BROWSE_CHUNK_METHOD,
  BROWSE_ENTRIES_METHOD,
  BROWSE_READ_AT_METHOD,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import {
  PHONE_SCREENS_ASK_FOR_METHOD,
  PHONE_SCREENS_ASK_METHOD,
  PHONE_SCREENS_LISTEN_METHOD,
  PHONE_SCREENS_REQUEST_METHOD,
} from '@aurigax-ai/ostia-extension-sdk/contract/phoneScreens'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { CommandDescriptor, CommandResult } from '../../shared/control/commands'
import { type ExtensionCommandRun, registerControlMethod } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'
import type { ExtensionHost } from './extensionHost'
import { fail } from './extensionRuntime'

function extensionHandler(host: () => ExtensionHost | null) {
  return (
    fn: (
      h: ExtensionHost,
      identity: PaneIdentity,
      conn: MessageConnection,
      params: unknown,
    ) => unknown,
  ) => ({
    callers: 'extensions' as const,
    handler: (params: unknown, ctx: { identity: PaneIdentity; conn: MessageConnection }) => {
      const h = host()
      if (!h) return fail('no-extension-host')
      return fn(h, ctx.identity, ctx.conn, params)
    },
  })
}

type ForExtension = ReturnType<typeof extensionHandler>

function invokeAsPane(
  h: ExtensionHost,
  identity: PaneIdentity,
  extId: string,
  command: string,
  args: unknown,
) {
  h.runs.reachHookCaller(extId, command, identity)
  return h.invoke(extId, command, args, h.paneCaller(identity, { extId, command }))
}

export function extensionCommandRunner(
  host: () => ExtensionHost | null,
): (desc: CommandDescriptor) => ExtensionCommandRun | null {
  return (desc) => {
    const h = host()
    const ref = h?.paletteCommand(desc.id)
    if (!h || !ref) return null
    const marked = desc.extension
    if (marked?.extId !== ref.extId || marked.command !== ref.command) return null
    return async (identity, args): Promise<CommandResult> => {
      const argument = isRecord(args) ? args.argument : undefined
      const res = await invokeAsPane(
        h,
        identity,
        ref.extId,
        ref.command,
        h.paletteArgs(ref.extId, ref.command, argument),
      )
      if (res.ok) return { ok: true, result: res.data }
      const message = res.message ? `${res.error}: ${res.message}` : res.error
      const code = res.error === 'needs-elevation' ? 'needs-elevation' : 'command-failed'
      return { ok: false, error: { code, message } }
    }
  }
}

export function registerExtensionMethods(host: () => ExtensionHost | null): void {
  const forExtension = extensionHandler(host)
  registerHostMethods(host, forExtension)
  registerWindowMethods(forExtension)
  registerRunMethods(host, forExtension)
  registerAssistMethods(forExtension)
  registerConfigMethods(forExtension)
  registerBrowseMethods(forExtension)
  registerPhoneScreenMethods(forExtension)
}

function registerHostMethods(host: () => ExtensionHost | null, forExtension: ForExtension): void {
  registerControlMethod(
    'ext.registerCommands',
    forExtension((h, id, conn, p) => h.events.registerCommands(id, conn, p)),
  )
  registerControlMethod(
    'ext.subscribe',
    forExtension((h, id, conn, p) => h.events.subscribe(id, conn, p)),
  )
  registerControlMethod(
    'ext.startWithWindow',
    forExtension((h, id, conn, p) => h.events.startWithWindow(id, conn, p)),
  )
  registerControlMethod('ext.list', {
    handler: () => host()?.listForAgents() ?? [],
  })
  registerControlMethod('ext.invoke', {
    handler: (params, ctx) => {
      const h = host()
      if (!h) return fail('no-extension-host')
      const p = (params ?? {}) as { extId?: unknown; command?: unknown; args?: unknown }
      if (typeof p.extId !== 'string' || typeof p.command !== 'string') {
        return fail('invalid-params', 'extId and command are required')
      }
      const release = h.runs.holdCliCall(ctx.identity, ctx.authed)
      const closed = ctx.conn.onClose(release)
      return invokeAsPane(h, ctx.identity, p.extId, p.command, p.args).finally(() => {
        closed.dispose()
        release()
      })
    },
  })
  registerControlMethod(
    'ext.redact',
    forExtension((h, id, conn, p) => h.redactTexts(id, conn, p)),
  )
  registerControlMethod(
    'ext.locale',
    forExtension((h, id, conn) => h.getLocale(id, conn)),
  )
  registerControlMethod(
    'ext.sandboxDomains',
    forExtension((h, id, conn, p) => h.sandboxDomains(id, conn, p)),
  )
}

function registerWindowMethods(forExtension: ForExtension): void {
  registerControlMethod(
    'ext.setSidebarItem',
    forExtension((h, id, conn, p) => h.slots.setSidebarItem(id, conn, p)),
  )
  registerControlMethod('ext.notify', {
    ...forExtension((h, id, conn, p) => h.windowRequests.notify(id, conn, p)),
    cap: 'notify',
  })
  registerControlMethod(
    'ext.openPanel',
    forExtension((h, id, conn, p) => h.windowRequests.openPanel(id, conn, p)),
  )
  registerControlMethod(
    'ext.setPanelToolbar',
    forExtension((h, id, conn, p) => h.slots.setPanelToolbar(id, conn, p)),
  )
  registerControlMethod(
    'ext.setInboxItems',
    forExtension((h, id, conn, p) => h.slots.setInboxItems(id, conn, p)),
  )
  registerControlMethod(
    'ext.setPaneChip',
    forExtension((h, id, conn, p) => h.slots.setPaneChip(id, conn, p)),
  )
  registerControlMethod(
    'ext.clearPaneChip',
    forExtension((h, id, conn, p) => h.slots.clearPaneChip(id, conn, p)),
  )
  registerControlMethod(
    'ext.setWorkspaceChip',
    forExtension((h, id, conn, p) => h.slots.setWorkspaceChip(id, conn, p)),
  )
  registerControlMethod(
    'ext.clearWorkspaceChip',
    forExtension((h, id, conn, p) => h.slots.clearWorkspaceChip(id, conn, p)),
  )
  registerControlMethod(
    'ext.openDiff',
    forExtension((h, id, conn, p) => h.windowRequests.openDiff(id, conn, p)),
  )
  registerControlMethod(
    'ext.openFile',
    forExtension((h, id, conn, p) => h.windowRequests.openFile(id, conn, p)),
  )
  registerControlMethod(
    'ext.openFolder',
    forExtension((h, id, conn, p) => h.windowRequests.openFolder(id, conn, p)),
  )
  registerControlMethod(
    'ext.closeFolder',
    forExtension((h, id, conn, p) => h.windowRequests.closeFolder(id, conn, p)),
  )
}

function registerRunMethods(host: () => ExtensionHost | null, forExtension: ForExtension): void {
  registerControlMethod('ext.openTerminal', {
    ...forExtension((h, id, conn, p) => h.runs.openTerminal(id, conn, p)),
    cap: 'shell',
  })
  registerControlMethod('ext.agents', {
    ...forExtension((h, id, conn) => h.runs.agentNames(id, conn)),
    cap: 'shell',
  })
  registerControlMethod('ext.exec', {
    callers: 'extensions',
    cap: 'process',
    handler: (params: unknown, ctx) => {
      const h = host()
      if (!h) return fail('no-extension-host')
      return h.runs.exec(ctx.identity, ctx.conn, params, ctx.token)
    },
  })
  registerControlMethod('ext.runAgent', {
    ...forExtension((h, id, conn, p) => h.runs.runAgent(id, conn, p)),
    cap: 'shell',
  })
  registerControlMethod(
    'ext.requireCallerCaps',
    forExtension((h, id, conn, p) => h.runs.requireCallerCaps(id, conn, p)),
  )
  registerControlMethod(
    'ext.playbookEnabled',
    forExtension((h, id, conn) => h.runs.playbookEnabled(id, conn)),
  )
  registerControlMethod(
    'ext.offerToAgent',
    forExtension((h, id, conn, p) => h.runs.offerToAgent(id, conn, p)),
  )
  registerControlMethod(
    'ext.focusPane',
    forExtension((h, id, conn, p) => h.runs.focusPane(id, conn, p)),
  )
  registerControlMethod(
    'ext.confirm',
    forExtension((h, id, conn, p) => h.runs.confirm(id, conn, p)),
  )
}

function registerAssistMethods(forExtension: ForExtension): void {
  registerControlMethod('ext.setAssistStatus', {
    ...forExtension((h, id, conn, p) => h.assistant.setAssistStatus(id, conn, p)),
    cap: 'assist',
  })
  registerControlMethod('ext.assistProviders', {
    ...forExtension((h, id, conn) => h.assistant.getAssistProviders(id, conn)),
    cap: 'assist',
  })
  registerControlMethod('ext.assistChunk', {
    ...forExtension((h, id, conn, p) => h.assistant.assistChunk(id, conn, p)),
    cap: 'assist',
  })
  registerControlMethod(
    'ext.shortcuts',
    forExtension((h, id, conn, p) => h.assistant.getShortcuts(id, conn, p)),
  )
  registerControlMethod(
    'ext.openAssistUi',
    forExtension((h, id, conn, p) => h.assistant.openAssistUi(id, conn, p)),
  )
}

function registerConfigMethods(forExtension: ForExtension): void {
  registerControlMethod(
    'ext.getSettings',
    forExtension((h, id, conn) => h.config.getSettings(id, conn)),
  )
  registerControlMethod(
    'ext.setSetting',
    forExtension((h, id, conn, p) => h.config.setOwnSetting(id, conn, p)),
  )
  registerControlMethod(
    'ext.getSecret',
    forExtension((h, id, conn, p) => h.config.getSecret(id, conn, p)),
  )
  registerControlMethod(
    'ext.connections',
    forExtension((h, id, conn) => h.config.listConnections(id, conn)),
  )
  registerControlMethod(
    'ext.connection',
    forExtension((h, id, conn, p) => h.config.getConnection(id, conn, p)),
  )
}

function registerBrowseMethods(forExtension: ForExtension): void {
  registerControlMethod(BROWSE_READ_AT_METHOD, {
    ...forExtension((h, id, conn, p) => h.browse.readAt(id, conn, p)),
    cap: 'file-contents',
  })
  registerControlMethod(BROWSE_ENTRIES_METHOD, {
    ...forExtension((h, id, conn, p) => h.browse.entries(id, conn, p)),
    cap: 'file-contents',
  })
  registerControlMethod(BROWSE_CHUNK_METHOD, {
    ...forExtension((h, id, conn, p) => h.browse.chunk(id, conn, p)),
    cap: 'file-contents',
  })
}

function registerPhoneScreenMethods(forExtension: ForExtension): void {
  registerControlMethod(PHONE_SCREENS_LISTEN_METHOD, {
    ...forExtension((h, id, conn) => h.phoneScreens.listen(id, conn)),
    cap: 'phone-screens',
  })
  registerControlMethod(PHONE_SCREENS_REQUEST_METHOD, {
    ...forExtension((h, id, conn, p) => h.phoneScreens.request(id, conn, p)),
    cap: 'phone-screens',
  })
  registerControlMethod(PHONE_SCREENS_ASK_METHOD, {
    ...forExtension((h, id, conn, p) => h.phoneScreens.ask(id, conn, p)),
    cap: 'phone-screens',
  })
  registerControlMethod(PHONE_SCREENS_ASK_FOR_METHOD, {
    ...forExtension((h, id, conn, p) => h.phoneScreens.askFor(id, conn, p)),
    cap: 'phone-screens',
  })
}
