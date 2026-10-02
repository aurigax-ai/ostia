import type { ExtensionCaller } from '../../shared/extensions'
import {
  type CommandHandler,
  type ConfirmRequest,
  type ExtensionResult,
  type OpenFolderOptions,
  type OpenFolderResult,
  cliArgs,
  failure,
  ok,
} from '../sdk'
import { type HelperChannel, HelperFailure } from './channel'
import type { HelperConsent } from './consent'
import type { HelperFolders, Sessions } from './folders'
import { HELPER_PROTOCOL, type HelperBundle, SESSION_FILE } from './helper'
import type { HelperHosts } from './helperHosts'
import { type ConnectPlan, hostKey, planConnect } from './plan'
import { HELPER_INSTALL_USAGE, HELPER_REMOVE_USAGE, type Strings, stringsFor } from './strings'
import { type RunSsh, type SshTarget, resolveTarget } from './target'

export interface HelperDeps {
  run: RunSsh
  confirm: (req: ConfirmRequest) => Promise<boolean>
  enabled: () => Promise<boolean>
  consent: HelperConsent
  hosts: HelperHosts
  helper: HelperBundle
  now?: () => Date
  sessions: Sessions
  folders: HelperFolders
  openFolder: (opts: OpenFolderOptions) => Promise<OpenFolderResult>
  closeFolder: (folderId: string) => Promise<unknown>
}

export function failureOf(err: unknown, s: Strings): ExtensionResult {
  if (!(err instanceof HelperFailure)) {
    return failure('helper-failed', err instanceof Error ? err.message : String(err))
  }
  switch (err.code) {
    case 'ssh-missing':
      return failure('ssh-missing', s.sshMissing)
    case 'connect-failed':
      return failure('connect-failed', s.helperConnectFailed(err.detail ?? s.timedOut))
    case 'timeout':
      return failure('timeout', s.helperTimeout)
    case 'needs-tool':
      return failure('needs-tool', s.helperNeeds(err.detail ?? '?'))
    case 'missing':
    case 'corrupt':
    case 'install-failed':
      return failure('install-failed', s.helperInstallFailed(err.detail ?? err.code))
    case 'remove-failed':
      return failure('remove-failed', s.helperRemoveFailed)
    default:
      return failure('protocol', s.helperProtocol)
  }
}

function login(plan: ConnectPlan, target: SshTarget): string {
  const host = target.hostname ?? target.alias
  const port = plan.port ?? target.port
  const address = port === undefined ? host : `${host}:${port}`
  return target.user ? `${target.user}@${address}` : address
}

export function installConfirm(
  plan: ConnectPlan,
  target: SshTarget,
  helper: HelperBundle,
  s: Strings,
): ConfirmRequest {
  return {
    title: s.installTitle,
    message: s.installMessage(hostKey(plan)),
    detail: [
      `${s.hostLabel} ${login(plan, target)}`,
      `${s.fileLabel} ${helper.path}, ${SESSION_FILE}`,
      '',
      s.installNote,
    ].join('\n'),
    confirmLabel: s.install,
    cancelLabel: s.dontInstall,
  }
}

export type Ensured =
  | { ok: true; channel: HelperChannel; installed: boolean }
  | { ok: false; result: ExtensionResult }

function refusal(caller: ExtensionCaller, s: Strings): ExtensionResult | null {
  if (caller.sandboxed) return failure('sandboxed', s.sandboxed)
  if (caller.kind !== 'user') return failure('human-only', s.humanOnly)
  return null
}

async function openOrInstall(
  plan: ConnectPlan,
  deps: HelperDeps,
  installFirst: boolean,
): Promise<{ channel: HelperChannel; installed: boolean }> {
  if (!installFirst) {
    try {
      return { channel: await deps.hosts.channel(plan), installed: false }
    } catch (err) {
      const absent =
        err instanceof HelperFailure && (err.code === 'missing' || err.code === 'corrupt')
      if (!absent) throw err
    }
  }
  await deps.hosts.install(plan)
  return { channel: await deps.hosts.channel(plan), installed: true }
}

export async function ensureHelper(
  plan: ConnectPlan,
  target: SshTarget,
  s: Strings,
  deps: HelperDeps,
): Promise<Ensured> {
  if (!(await deps.enabled())) return { ok: false, result: failure('helper-off', s.helperOff) }
  const key = hostKey(plan)
  const record = deps.consent.get(key)
  if (record?.answer === 'refused') {
    return { ok: false, result: failure('helper-refused', s.helperRefused(key)) }
  }
  const consented = record?.answer === 'allowed' && record.version === deps.helper.version
  if (!consented) {
    const approved = await deps.confirm(installConfirm(plan, target, deps.helper, s))
    const at = (deps.now?.() ?? new Date()).toISOString()
    if (!approved) {
      deps.consent.set(key, { answer: 'refused', at })
      return { ok: false, result: failure('helper-refused', s.helperRefused(key)) }
    }
    deps.consent.set(key, { answer: 'allowed', version: deps.helper.version, at })
  }
  try {
    const opened = await openOrInstall(plan, deps, !consented)
    const stored = deps.consent.get(key)
    if (stored?.answer === 'allowed' && !stored.installed) {
      deps.consent.set(key, { ...stored, installed: true })
    }
    return { ok: true, ...opened }
  } catch (err) {
    return { ok: false, result: failureOf(err, s) }
  }
}

function argvOf(args: unknown): string[] {
  return cliArgs(args)?.argv ?? []
}

async function closeFoldersOn(key: string, deps: HelperDeps): Promise<void> {
  for (const folderId of deps.folders.idsOn(key)) {
    deps.folders.remove(folderId)
    await deps.closeFolder(folderId)
  }
}

async function resolved(
  plan: ConnectPlan,
  s: Strings,
  deps: HelperDeps,
): Promise<{ ok: true; target: SshTarget } | { ok: false; result: ExtensionResult }> {
  const found = await resolveTarget(plan.destination, deps.run)
  if (found.ok) return found
  if (found.error === 'ssh-missing')
    return { ok: false, result: failure('ssh-missing', s.sshMissing) }
  return {
    ok: false,
    result: failure('resolve-failed', s.resolveFailed(found.reason ?? s.timedOut)),
  }
}

export function installedHelper(plan: ConnectPlan, deps: HelperDeps): HelperBundle | null {
  const record = deps.consent.get(hostKey(plan))
  const current = record?.answer === 'allowed' && record.version === deps.helper.version
  return current && record.installed ? deps.helper : null
}

export function helperCommands(
  deps: HelperDeps,
): Record<'open-folder' | 'helper-install' | 'helper-remove' | 'helpers', CommandHandler> {
  return {
    'open-folder': async (_args, caller) => {
      const s = stringsFor(caller.locale)
      const refused = refusal(caller, s)
      if (refused) return refused
      const plan = deps.sessions.planOf(caller.paneId)
      if (!plan || !caller.workspaceId) return failure('not-a-session', s.notASession)
      if (!caller.remote) return failure('no-remote-folder', s.noRemoteFolder)
      if (!(await deps.enabled())) return failure('helper-off', s.helperOff)
      const found = await resolved(plan, s, deps)
      if (!found.ok) return found.result
      const ensured = await ensureHelper(plan, found.target, s, deps)
      if (!ensured.ok) return ensured.result
      const host = hostKey(plan)
      const opened = await deps.openFolder({
        workspaceId: caller.workspaceId,
        host,
        path: caller.remote.cwd,
      })
      if (!opened.ok) {
        return failure(opened.error, opened.error === 'denied' ? s.folderDenied : opened.message)
      }
      deps.folders.add(opened.folderId, plan)
      return ok(undefined, { folderId: opened.folderId, host, path: caller.remote.cwd })
    },

    'helper-install': async (args, caller) => {
      const s = stringsFor(caller.locale)
      const refused = refusal(caller, s)
      if (refused) return refused
      const plan = planConnect(argvOf(args))
      if (!plan) return failure('invalid-args', HELPER_INSTALL_USAGE)
      if (!(await deps.enabled())) return failure('helper-off', s.helperOff)
      const found = await resolved(plan, s, deps)
      if (!found.ok) return found.result
      const ensured = await ensureHelper(plan, found.target, s, deps)
      if (!ensured.ok) return ensured.result
      return ok(undefined, {
        host: hostKey(plan),
        version: deps.helper.version,
        protocol: HELPER_PROTOCOL,
        path: deps.helper.path,
        installed: ensured.installed,
      })
    },

    'helper-remove': async (args, caller) => {
      const s = stringsFor(caller.locale)
      const refused = refusal(caller, s)
      if (refused) return refused
      const plan = planConnect(argvOf(args))
      if (!plan) return failure('invalid-args', HELPER_REMOVE_USAGE)
      const key = hostKey(plan)
      if (deps.consent.get(key)?.answer === 'refused') {
        deps.consent.forget(key)
        return ok(undefined, { host: key, removed: false, forgotten: true })
      }
      const approved = await deps.confirm({
        title: s.removeTitle,
        message: s.removeMessage(key),
        detail: s.removeNote,
        confirmLabel: s.remove,
        cancelLabel: s.cancel,
      })
      if (!approved) return failure('denied', s.removeDenied)
      await closeFoldersOn(key, deps)
      try {
        await deps.hosts.remove(plan)
      } catch (err) {
        return failureOf(err, s)
      }
      deps.consent.forget(key)
      return ok(undefined, { host: key, removed: true, forgotten: true })
    },

    helpers: async (_args, caller) => {
      if (caller.sandboxed) return failure('sandboxed', stringsFor(caller.locale).sandboxed)
      return ok(undefined, {
        version: deps.helper.version,
        hosts: deps.consent.all().map(([host, record]) => ({
          host,
          answer: record.answer,
          ...(record.version ? { version: record.version } : {}),
          current: record.version === deps.helper.version,
          installed: record.installed === true,
          connected: deps.hosts.isConnected(host),
          folders: deps.folders.idsOn(host).length,
        })),
      })
    },
  }
}
