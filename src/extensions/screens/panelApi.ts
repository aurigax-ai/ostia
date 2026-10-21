import {
  type ConfirmRequest,
  type ExtensionResult,
  failure,
  type OpenTerminalOptions,
  type OpenTerminalResult,
  ok,
  type SandboxDomainsResult,
  type Translate,
} from '@aurigax-ai/ostia-extension-sdk'
import type { CreateGate } from './createGate'
import { type InstallState, SERVICE_INSTALL } from './install'
import type { PanelScope } from './panelServer'
import type { PhoneLinks, PhoneView } from './phoneLinks'
import type { OwnedScreen } from './screenRegistry'
import { isOutdated, MIN_SERVICE_VERSION, runScreens, serviceVersion } from './screensCli'
import type { ScreensService, ShownScreen } from './screensService'
import type { Viewers } from './viewers'

const AGENT_DRIVING_MS = 10_000

export interface PanelInstall extends InstallState {
  version: string | null
  outdated: boolean
  minVersion: string
}

export interface PanelScreen extends ShownScreen {
  agentDriving: boolean
  phone?: PhoneView
}

export interface PanelPhones {
  listening: boolean
  asked: boolean
}

export interface PanelScopeWithSandbox extends PanelScope {
  sandboxed: boolean
}

export interface PanelDeps {
  service: ScreensService
  gate: CreateGate
  translate: (locale?: string) => Translate
  installState: (reason: string) => InstallState
  confirm: (req: ConfirmRequest) => Promise<boolean>
  openTerminal: (opts: OpenTerminalOptions) => Promise<OpenTerminalResult>
  sandboxDomains: (workspaceId: string) => Promise<SandboxDomainsResult>
  viewers: Viewers
  phones: () => PhoneLinks | null
  now: () => number
}

type PanelHandler = (args: unknown, scope: PanelScopeWithSandbox) => Promise<ExtensionResult>

function screenIdOf(args: unknown): string | null {
  const id = (args as { id?: unknown } | null)?.id
  return typeof id === 'string' && id ? id : null
}

async function lastAgentAction(screen: OwnedScreen): Promise<number | null> {
  const res = await runScreens<{ entries?: { time?: unknown }[] }>({
    args: ['log', screen.id],
    token: screen.viewerToken,
  })
  const time = res.ok ? res.value.entries?.at(-1)?.time : undefined
  const at = typeof time === 'string' ? Date.parse(time) : Number.NaN
  return Number.isFinite(at) ? at : null
}

export function panelHandlers(deps: PanelDeps): Record<string, PanelHandler> {
  const t = (scope: PanelScope): Translate => deps.translate(scope.locale)

  const own = (args: unknown, scope: PanelScope): OwnedScreen | null => {
    const id = screenIdOf(args)
    const screen = id ? deps.service.registry.get(id) : undefined
    return screen && screen.workspaceId === scope.workspaceId ? screen : null
  }

  const switchOwner =
    (verb: 'takeover' | 'giveback'): PanelHandler =>
    async (args, scope) => {
      const screen = own(args, scope)
      if (!screen)
        return failure('refused', t(scope)('verb.notHere', { id: screenIdOf(args) ?? '' }))
      const viewer = await deps.viewers.viewerOf(scope.panel, screen.id)
      if (!viewer) return failure('no-view', t(scope)('panel.noView'))
      const res = await runScreens<{ owner: string }>({
        args: [verb, screen.id, viewer],
        token: screen.viewerToken,
      })
      return res.ok ? ok(undefined, res.value) : failure(res.code, res.message)
    }

  const panelScreen = async (shown: ShownScreen): Promise<PanelScreen> => {
    const phone = deps.phones()?.view(shown.id)
    if (phone) return { ...shown, agentDriving: false, phone }
    const screen = deps.service.registry.get(shown.id)
    if (!screen || shown.owner !== 'agent') return { ...shown, agentDriving: false }
    const at = await lastAgentAction(screen)
    return { ...shown, agentDriving: at !== null && deps.now() - at < AGENT_DRIVING_MS }
  }

  const installWithVersion = async (scope: PanelScope): Promise<PanelInstall> => {
    const install = deps.installState(t(scope)('install.reason'))
    const version = install.service ? await serviceVersion() : null
    return {
      ...install,
      version,
      outdated: version !== null && isOutdated(version),
      minVersion: MIN_SERVICE_VERSION,
    }
  }

  const serviceInstall = async (
    scope: PanelScope,
    kind: 'install' | 'update',
  ): Promise<ExtensionResult> => {
    const tr = t(scope)
    const approved = await deps.confirm({
      title: tr(`${kind}.title`),
      message: tr(`${kind}.message`),
      detail: tr('install.detail'),
      confirmLabel: tr(`${kind}.confirm`),
      cancelLabel: tr('cancel'),
      hostTerminal: SERVICE_INSTALL,
    })
    if (!approved) return failure('cancelled', tr('install.cancelled'))
    const opened = await deps.openTerminal({
      command: SERVICE_INSTALL,
      host: true,
      workspaceId: scope.workspaceId,
      title: tr('install.terminalTitle'),
    })
    return opened.ok ? ok() : failure(opened.error, opened.message)
  }

  return {
    state: async (_args, scope) =>
      ok(undefined, {
        install: await installWithVersion(scope),
        screens: await Promise.all((await deps.service.shown(scope.workspaceId)).map(panelScreen)),
        always: deps.gate.isAlways(scope.workspaceId),
        phones: {
          listening: deps.phones() !== null,
          asked: deps.phones()?.askedRecently(scope.workspaceId) === true,
        } satisfies PanelPhones,
      }),

    watch: async (args, scope) => {
      const screen = own(args, scope)
      const phones = deps.phones()
      if (!screen || !phones) {
        return failure('refused', t(scope)('verb.notHere', { id: screenIdOf(args) ?? '' }))
      }
      const on = (args as { on?: unknown }).on === true
      return (await phones.watch(screen.id, on))
        ? ok()
        : failure('phone', t(scope)('panel.phoneFailed'))
    },

    frame: async (args, scope) => {
      const screen = own(args, scope)
      return ok(undefined, screen ? (deps.phones()?.latest(screen.id) ?? null) : null)
    },

    ask: async (_args, scope) => {
      const phones = deps.phones()
      if (!phones) return failure('phone', t(scope)('panel.phoneFailed'))
      return (await phones.ask(scope.workspaceId))
        ? ok()
        : failure('phone', t(scope)('panel.phoneFailed'))
    },

    takeover: switchOwner('takeover'),
    giveback: switchOwner('giveback'),

    create: async (_args, scope) => {
      let allow: string[] = []
      if (scope.sandboxed) {
        const domains = await deps.sandboxDomains(scope.workspaceId)
        if (!domains.ok) return failure('sandbox-domains', domains.message ?? domains.error)
        allow = domains.domains
      }
      const res = await deps.service.create({ workspaceId: scope.workspaceId, allow })
      if (res.ok) return ok(undefined, { id: res.value.id })
      if (res.code !== 'outdated') return failure(res.code, res.message)
      return failure(
        'outdated',
        t(scope)('verb.outdated', { version: res.message, min: MIN_SERVICE_VERSION }),
      )
    },

    stop: async (args, scope) => {
      const screen = own(args, scope)
      if (!screen) {
        return failure('refused', t(scope)('verb.notHere', { id: screenIdOf(args) ?? '' }))
      }
      const res = await deps.service.stop(screen.id)
      return res.ok ? ok() : failure(res.code, res.message)
    },

    revoke: async (_args, scope) => {
      deps.gate.revoke(scope.workspaceId)
      return ok()
    },

    install: (_args, scope) => serviceInstall(scope, 'install'),
    update: (_args, scope) => serviceInstall(scope, 'update'),
    installSystem: async (_args, scope) => {
      const tr = t(scope)
      const argv = deps.installState(tr('install.reason')).systemInstall
      if (!argv) return failure('no-manager', tr('install.noManager'))
      const opened = await deps.openTerminal({
        command: argv,
        workspaceId: scope.workspaceId,
        title: tr('install.systemTitle'),
      })
      return opened.ok ? ok() : failure(opened.error, opened.message)
    },
  }
}
