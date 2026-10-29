import {
  type CommandHandler,
  type ConfirmRequest,
  cliArgs,
  type ExtensionResult,
  failure,
  type OpenTerminalResult,
  ok,
  type Translate,
} from '@aurigax-ai/ostia-extension-sdk'
import type {
  ExtensionCaller,
  OpenTerminalOptions,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import type { RemoteAgent, SetupStep, SetupStepId } from '../../../shared/remote/remoteSetup'
import type { HelperConsent } from '../consent'
import { type ConnectPlan, hostKey, planConnect, planRemote } from '../plan'
import { attachArgv } from './attach'
import { type NodeBundle, remoteWord } from './bundle'
import { probeProblem } from './probe'
import type { RemoteRegistry } from './registry'
import { classify, RemoteFailure, type RunnerClient } from './runnerClient'

export interface RemoteDeps {
  translate: (locale: string | undefined) => Translate
  confirm: (req: ConfirmRequest) => Promise<boolean>
  openTerminal: (opts: OpenTerminalOptions) => Promise<OpenTerminalResult>
  client: (plan: ConnectPlan) => RunnerClient
  bundle: NodeBundle
  consent: HelperConsent
  registry: RemoteRegistry
  now?: () => Date
}

interface Choice {
  host: string
  agent: RemoteAgent
  folder: string
}

const LOGIN_COMMAND: Record<RemoteAgent, string> = {
  claude: 'exec claude',
  codex: 'exec codex login --device-auth',
}

function jsonArg(args: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(cliArgs(args)?.argv[0] ?? '')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function isAgent(value: unknown): value is RemoteAgent {
  return value === 'claude' || value === 'codex'
}

function choiceOf(args: unknown): (Choice & { plan: ConnectPlan }) | null {
  const { host, agent, folder } = jsonArg(args)
  if (typeof host !== 'string') return null
  const plan = planConnect([host])
  if (!plan) return null
  return {
    host,
    agent: isAgent(agent) ? agent : 'claude',
    folder: typeof folder === 'string' ? folder : '',
    plan,
  }
}

function refusal(caller: ExtensionCaller, t: Translate): ExtensionResult | null {
  if (caller.sandboxed) return failure('sandboxed', t('sandboxed'))
  if (caller.kind !== 'user') return failure('human-only', t('humanOnly'))
  return null
}

function stepOf(id: SetupStepId, failed?: RemoteFailure): ExtensionResult {
  const step: SetupStep = failed
    ? {
        id,
        state: 'failed',
        error:
          failed.code === 'missing' || failed.code === 'corrupt' || failed.code === 'not-signed-in'
            ? 'install-failed'
            : failed.code,
        ...(failed.detail ? { detail: failed.detail } : {}),
      }
    : { id, state: 'done' }
  return ok(undefined, step)
}

async function install(plan: ConnectPlan, t: Translate, deps: RemoteDeps): Promise<void> {
  const key = `node:${hostKey(plan)}`
  const record = deps.consent.get(key)
  const { bundle } = deps
  if (record?.answer === 'refused') throw new RemoteFailure('install-failed', t('nodeRefused'))
  const consented = record?.answer === 'allowed' && record.version === bundle.version
  if (!consented) {
    const approved = await deps.confirm({
      title: t('nodeInstallTitle'),
      message: t('nodeInstallMessage', { host: hostKey(plan), product: PRODUCT_DISPLAY_NAME }),
      detail: t('nodeInstallNote'),
      confirmLabel: t('install'),
      cancelLabel: t('dontInstall'),
    })
    const at = (deps.now?.() ?? new Date()).toISOString()
    deps.consent.set(
      key,
      approved ? { answer: 'allowed', version: bundle.version, at } : { answer: 'refused', at },
    )
    if (!approved) throw new RemoteFailure('install-failed', t('nodeRefused'))
  }
  const client = deps.client(plan)
  try {
    await client.ensure()
  } catch (err) {
    const failed = classify(err)
    if (failed.code !== 'missing' && failed.code !== 'corrupt') throw failed
    await client.install()
    await client.ensure()
  }
}

async function login(
  choice: Choice & { plan: ConnectPlan },
  caller: ExtensionCaller,
  deps: RemoteDeps,
) {
  const opened = await deps.openTerminal({
    command: planRemote(choice.plan, remoteWord(LOGIN_COMMAND[choice.agent]), ['-t']),
    ...(caller.workspaceId ? { workspaceId: caller.workspaceId } : {}),
    title: choice.host,
  })
  if (!opened.ok) throw new RemoteFailure('network', opened.message ?? opened.error)
}

async function checkSignin(
  choice: Choice & { plan: ConnectPlan },
  client: RunnerClient,
): Promise<void> {
  if (!(await client.signedIn(choice.agent))) throw new RemoteFailure('not-signed-in')
}

async function runStep(
  step: SetupStepId,
  choice: Choice & { plan: ConnectPlan },
  caller: ExtensionCaller,
  t: Translate,
  deps: RemoteDeps,
  args: Record<string, unknown>,
): Promise<void> {
  const client = deps.client(choice.plan)
  if (step === 'connect') return client.reach()
  if (step === 'tools') {
    const problem = probeProblem(await client.probe(), choice.agent)
    if (problem) throw new RemoteFailure(problem.error, problem.detail)
    return
  }
  if (step === 'install') return install(choice.plan, t, deps)
  if (step === 'signin')
    return args.check === true ? checkSignin(choice, client) : login(choice, caller, deps)
  const answered = await client.selftest().catch(() => false)
  if (!answered) throw new RemoteFailure('runner-stopped')
}

const STEPS: readonly SetupStepId[] = ['connect', 'tools', 'install', 'signin', 'check']

export function remoteCommands(
  deps: RemoteDeps,
): Record<
  'remote-step' | 'remote-open' | 'remote-attach' | 'remote-jobs' | 'remote-stop',
  CommandHandler
> {
  const guarded =
    (
      run: (
        choice: Choice & { plan: ConnectPlan },
        caller: ExtensionCaller,
        t: Translate,
        args: Record<string, unknown>,
      ) => Promise<ExtensionResult>,
    ): CommandHandler =>
    async (args, caller) => {
      const t = deps.translate(caller.locale)
      const refused = refusal(caller, t)
      if (refused) return refused
      const choice = choiceOf(args)
      if (!choice) return failure('invalid-args', t('remoteUsage'))
      try {
        return await run(choice, caller, t, jsonArg(args))
      } catch (err) {
        const failed = classify(err)
        return failure(failed.code, failed.detail ?? failed.code)
      }
    }

  const openTab = async (
    choice: Choice & { plan: ConnectPlan },
    caller: ExtensionCaller,
    t: Translate,
    pane: string,
  ): Promise<ExtensionResult> => {
    const opened = await deps.openTerminal({
      command: attachArgv(choice.plan, pane, {
        disconnected: t('disconnected', { host: choice.host }),
        failed: t('connectFailed', { host: choice.host }),
      }),
      ...(caller.workspaceId ? { workspaceId: caller.workspaceId } : {}),
      title: choice.host,
    })
    if (!opened.ok) return failure('not-opened', opened.message ?? opened.error)
    if (caller.workspaceId) {
      deps.registry.addTab(opened.paneId, {
        workspaceId: caller.workspaceId,
        host: choice.host,
        pane,
      })
    }
    return ok(undefined, { paneId: opened.paneId, pane })
  }

  return {
    'remote-step': guarded(async (choice, caller, t, args) => {
      const step = STEPS.find((id) => id === args.step)
      if (!step) return failure('invalid-args', t('remoteUsage'))
      try {
        await runStep(step, choice, caller, t, deps, args)
      } catch (err) {
        const failed = classify(err)
        return failed.code === 'not-signed-in'
          ? ok(undefined, { id: step, state: 'waiting' } satisfies SetupStep)
          : stepOf(step, failed)
      }
      return step === 'signin' && args.check !== true
        ? ok(undefined, { id: step, state: 'waiting' } satisfies SetupStep)
        : stepOf(step)
    }),

    'remote-open': guarded(async (choice, caller, t) => {
      if (!caller.workspaceId) return failure('no-workspace', t('remoteUsage'))
      const client = deps.client(choice.plan)
      await client.ensure()
      deps.registry.addWorkspace(caller.workspaceId, {
        host: choice.host,
        folder: choice.folder,
        agent: choice.agent,
      })
      const pane = await client.paneNew({ agent: choice.agent, folder: choice.folder })
      return openTab(choice, caller, t, pane)
    }),

    'remote-attach': guarded(async (choice, caller, t, args) => {
      if (typeof args.pane !== 'string') return failure('invalid-args', t('remoteUsage'))
      return openTab(choice, caller, t, args.pane)
    }),

    'remote-jobs': guarded(async (choice) => {
      const client = deps.client(choice.plan)
      await client.ensure()
      return ok(undefined, { jobs: await client.jobs() })
    }),

    'remote-stop': guarded(async (choice, _caller, t, args) => {
      if (typeof args.pane !== 'string') return failure('invalid-args', t('remoteUsage'))
      await deps.client(choice.plan).stop(args.pane)
      return ok(undefined, { stopped: args.pane })
    }),
  }
}
