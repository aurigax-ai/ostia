import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  type CommandHandler,
  type ExtensionResult,
  failure,
  type OpenTerminalResult,
  ok,
  type Translate,
} from '@aurigax-ai/ostia-extension-sdk'
import type { OpenTerminalOptions } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import {
  isRepoHandoff,
  jobRef,
  mirrorPath,
  PROMPT_MAX,
  type RemoteStartInput,
} from '../../../shared/remote/remoteHandoff'
import { remoteRef } from '../../../shared/remote/remoteRef'
import { type ConnectPlan, hostKey, planConnect } from '../plan'
import { jsonArg } from './args'
import type { RemoteRegistry } from './registry'
import { classify, type RunnerClient } from './runnerClient'
import { openRemoteTab } from './tab'
import { type Consenting, consented, type Git, GitFailure, gitText, transferArgs } from './transfer'

const TITLE_MAX = 60
const START_TRIES = 3
const RETRY_MS = 2000

export interface StartDeps extends Consenting {
  translate: (locale: string | undefined) => Translate
  openTerminal: (opts: OpenTerminalOptions) => Promise<OpenTerminalResult>
  client: (plan: ConnectPlan) => RunnerClient
  registry: RemoteRegistry
  git: Git
  retryMs?: number
}

function inputOf(args: unknown): RemoteStartInput | null {
  const raw = jsonArg(args)
  const { agent, prompt, model, title, workspaceId, root, repo } = raw
  if (agent !== 'claude' && agent !== 'codex') return null
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > PROMPT_MAX) return null
  if (typeof title !== 'string' || !title || title.length > TITLE_MAX) return null
  if (typeof workspaceId !== 'string' || typeof root !== 'string' || !isAbsolute(root)) return null
  if (!isRepoHandoff(repo)) return null
  if (model !== undefined && typeof model !== 'string') return null
  return { agent, prompt, title, workspaceId, root, repo, ...(model ? { model } : {}) }
}

async function startWithRetry(
  client: RunnerClient,
  request: Parameters<RunnerClient['start']>[0],
  retryMs: number,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.start(request)
    } catch (err) {
      const failed = classify(err)
      if (failed.code !== 'network' || attempt >= START_TRIES) throw failed
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
  }
}

export function remoteStart(deps: StartDeps): CommandHandler {
  return async (args, caller): Promise<ExtensionResult> => {
    const t = deps.translate(caller.locale)
    if (caller.sandboxed) return failure('sandboxed', t('sandboxed'))
    if (caller.kind !== 'user') return failure('human-only', t('humanOnly'))
    const input = inputOf(args)
    if (!input) return failure('invalid-args', t('remoteUsage'))
    const workspace = deps.registry.workspace(input.workspaceId)
    const plan = workspace ? planConnect([workspace.host]) : null
    if (!workspace || !plan) return failure('not-remote', t('notRemote'))
    const { repo } = input
    const host = workspace.host
    const allowed = await consented(deps, `push:${hostKey(plan)}:${repo.id}`, {
      title: t('pushTitle'),
      message: t('pushMessage', { repo: repo.name, commit: repo.head.slice(0, 8), host }),
      detail: t('pushNote', { agent: input.agent, product: PRODUCT_DISPLAY_NAME }),
      confirmLabel: t('send'),
      cancelLabel: t('dontSend'),
    })
    if (!allowed) return failure('refused', t('pushRefused'))
    const jobId = randomBytes(4).toString('hex')
    const client = deps.client(plan)
    try {
      await client.ensure()
      await client.repoInit(repo.id)
      await gitText(deps.git, input.root, [
        ...transferArgs(plan),
        'push',
        '--no-verify',
        '--no-follow-tags',
        '--recurse-submodules=no',
        `${plan.destination}:${mirrorPath(repo.id)}`,
        `${repo.head}:${jobRef(jobId)}`,
      ])
      const outcome = await startWithRetry(
        client,
        {
          jobId,
          agent: input.agent,
          prompt: input.prompt,
          ...(input.model ? { model: input.model } : {}),
          repo,
        },
        deps.retryMs ?? RETRY_MS,
      )
      const ref = remoteRef(host, jobId)
      if (outcome.status === 'failed') {
        return failure('start-failed', t('startFailed', { ref, reason: outcome.reason }))
      }
      const tab = await openRemoteTab(deps, t, {
        plan,
        host,
        pane: outcome.pane,
        workspaceId: input.workspaceId,
        title: input.title,
      })
      if (!tab.ok) return tab
      const { paneId } = tab.data as { paneId: string }
      return ok(undefined, {
        jobId,
        ref,
        paneId,
        ...(outcome.session ? { session: outcome.session } : {}),
      })
    } catch (err) {
      if (err instanceof GitFailure) return failure('push-failed', err.message)
      const failed = classify(err)
      return failure(failed.code, failed.detail ?? failed.message)
    }
  }
}
