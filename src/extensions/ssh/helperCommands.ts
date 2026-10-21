import {
  type CommandHandler,
  type ConfirmRequest,
  cliArgs,
  type ExtensionResult,
  failure,
  type OpenFolderOptions,
  type OpenFolderResult,
  ok,
  type Translate,
} from '@aurigax-ai/ostia-extension-sdk'
import type { ExtensionCaller } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { type HelperChannel, HelperFailure } from './channel'
import type { HelperConsent } from './consent'
import type { HelperFolders, Sessions } from './folders'
import { HELPER_PROTOCOL, type HelperBundle, SESSION_FILE } from './helper'
import type { HelperHosts } from './helperHosts'
import { type ConnectPlan, hostKey, planConnect } from './plan'
import { type RunSsh, resolveTarget, type SshTarget } from './target'
import { HELPER_INSTALL_USAGE, HELPER_REMOVE_USAGE } from './usage'

export interface HelperDeps {
  translate: (locale: string | undefined) => Translate
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

function failureOf(err: unknown, t: Translate): ExtensionResult {
  if (!(err instanceof HelperFailure)) {
    return failure('helper-failed', err instanceof Error ? err.message : String(err))
  }
  switch (err.code) {
    case 'ssh-missing':
      return failure('ssh-missing', t('sshMissing'))
    case 'connect-failed':
      return failure(
        'connect-failed',
        t('helperConnectFailed', { reason: err.detail ?? t('timedOut') }),
      )
    case 'timeout':
      return failure('timeout', t('helperTimeout'))
    case 'needs-tool':
      return failure('needs-tool', t('helperNeeds', { tool: err.detail ?? '?' }))
    case 'missing':
    case 'corrupt':
    case 'install-failed':
      return failure('install-failed', t('helperInstallFailed', { reason: err.detail ?? err.code }))
    case 'remove-failed':
      return failure('remove-failed', t('helperRemoveFailed'))
    default:
      return failure('protocol', t('helperProtocol'))
  }
}

function login(plan: ConnectPlan, target: SshTarget): string {
  const host = target.hostname ?? target.alias
  const port = plan.port ?? target.port
  const address = port === undefined ? host : `${host}:${port}`
  return target.user ? `${target.user}@${address}` : address
}

function installConfirm(
  plan: ConnectPlan,
  target: SshTarget,
  helper: HelperBundle,
  t: Translate,
): ConfirmRequest {
  return {
    title: t('installTitle'),
    message: t('installMessage', { host: hostKey(plan), product: PRODUCT_DISPLAY_NAME }),
    detail: [
      `${t('hostLabel')} ${login(plan, target)}`,
      `${t('fileLabel')} ${helper.path}, ${SESSION_FILE}`,
      '',
      t('installNote'),
    ].join('\n'),
    confirmLabel: t('install'),
    cancelLabel: t('dontInstall'),
  }
}

type Ensured =
  | { ok: true; channel: HelperChannel; installed: boolean }
  | { ok: false; result: ExtensionResult }

function refusal(caller: ExtensionCaller, t: Translate): ExtensionResult | null {
  if (caller.sandboxed) return failure('sandboxed', t('sandboxed'))
  if (caller.kind !== 'user') return failure('human-only', t('humanOnly'))
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

async function ensureHelper(
  plan: ConnectPlan,
  target: SshTarget,
  t: Translate,
  deps: HelperDeps,
): Promise<Ensured> {
  if (!(await deps.enabled())) return { ok: false, result: failure('helper-off', t('helperOff')) }
  const key = hostKey(plan)
  const record = deps.consent.get(key)
  if (record?.answer === 'refused') {
    return { ok: false, result: failure('helper-refused', t('helperRefused', { host: key })) }
  }
  const consented = record?.answer === 'allowed' && record.version === deps.helper.version
  if (!consented) {
    const approved = await deps.confirm(installConfirm(plan, target, deps.helper, t))
    const at = (deps.now?.() ?? new Date()).toISOString()
    if (!approved) {
      deps.consent.set(key, { answer: 'refused', at })
      return { ok: false, result: failure('helper-refused', t('helperRefused', { host: key })) }
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
    return { ok: false, result: failureOf(err, t) }
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
  t: Translate,
  deps: HelperDeps,
): Promise<{ ok: true; target: SshTarget } | { ok: false; result: ExtensionResult }> {
  const found = await resolveTarget(plan.destination, deps.run)
  if (found.ok) return found
  if (found.error === 'ssh-missing')
    return { ok: false, result: failure('ssh-missing', t('sshMissing')) }
  return {
    ok: false,
    result: failure(
      'resolve-failed',
      t('resolveFailed', { reason: found.reason ?? t('timedOut') }),
    ),
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
      const t = deps.translate(caller.locale)
      const refused = refusal(caller, t)
      if (refused) return refused
      const plan = deps.sessions.planOf(caller.paneId)
      if (!plan || !caller.workspaceId) return failure('not-a-session', t('notASession'))
      if (!caller.remote) return failure('no-remote-folder', t('noRemoteFolder'))
      if (!(await deps.enabled())) return failure('helper-off', t('helperOff'))
      const found = await resolved(plan, t, deps)
      if (!found.ok) return found.result
      const ensured = await ensureHelper(plan, found.target, t, deps)
      if (!ensured.ok) return ensured.result
      const host = hostKey(plan)
      const opened = await deps.openFolder({
        workspaceId: caller.workspaceId,
        host,
        path: caller.remote.cwd,
      })
      if (!opened.ok) {
        return failure(opened.error, opened.error === 'denied' ? t('folderDenied') : opened.message)
      }
      deps.folders.add(opened.folderId, plan)
      return ok(undefined, { folderId: opened.folderId, host, path: caller.remote.cwd })
    },

    'helper-install': async (args, caller) => {
      const t = deps.translate(caller.locale)
      const refused = refusal(caller, t)
      if (refused) return refused
      const plan = planConnect(argvOf(args))
      if (!plan) return failure('invalid-args', HELPER_INSTALL_USAGE)
      if (!(await deps.enabled())) return failure('helper-off', t('helperOff'))
      const found = await resolved(plan, t, deps)
      if (!found.ok) return found.result
      const ensured = await ensureHelper(plan, found.target, t, deps)
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
      const t = deps.translate(caller.locale)
      const refused = refusal(caller, t)
      if (refused) return refused
      const plan = planConnect(argvOf(args))
      if (!plan) return failure('invalid-args', HELPER_REMOVE_USAGE)
      const key = hostKey(plan)
      if (deps.consent.get(key)?.answer === 'refused') {
        deps.consent.forget(key)
        return ok(undefined, { host: key, removed: false, forgotten: true })
      }
      const approved = await deps.confirm({
        title: t('removeTitle'),
        message: t('removeMessage', { host: key, product: PRODUCT_DISPLAY_NAME }),
        detail: t('removeNote'),
        confirmLabel: t('remove'),
        cancelLabel: t('cancel'),
      })
      if (!approved) return failure('denied', t('removeDenied'))
      await closeFoldersOn(key, deps)
      try {
        await deps.hosts.remove(plan)
      } catch (err) {
        return failureOf(err, t)
      }
      deps.consent.forget(key)
      return ok(undefined, { host: key, removed: true, forgotten: true })
    },

    helpers: async (_args, caller) => {
      if (caller.sandboxed) return failure('sandboxed', deps.translate(caller.locale)('sandboxed'))
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
