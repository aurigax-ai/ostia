import {
  type ExtensionResult,
  failure,
  type OpenTerminalResult,
  ok,
  type Translate,
} from '@aurigax-ai/ostia-extension-sdk'
import type { OpenTerminalOptions } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { ConnectPlan } from '../plan'
import { attachArgv } from './attach'
import type { RemoteRegistry } from './registry'

export interface TabDeps {
  openTerminal: (opts: OpenTerminalOptions) => Promise<OpenTerminalResult>
  registry: RemoteRegistry
}

export interface TabTarget {
  plan: ConnectPlan
  host: string
  pane: string
  workspaceId?: string
  title?: string
}

export async function openRemoteTab(
  deps: TabDeps,
  t: Translate,
  target: TabTarget,
): Promise<ExtensionResult> {
  const { host, pane, workspaceId } = target
  const opened = await deps.openTerminal({
    command: attachArgv(target.plan, pane, {
      disconnected: t('disconnected', { host }),
      failed: t('connectFailed', { host }),
    }),
    ...(workspaceId ? { workspaceId } : {}),
    title: target.title ?? host,
  })
  if (!opened.ok) return failure('not-opened', opened.message ?? opened.error)
  if (workspaceId) deps.registry.addTab(opened.paneId, { workspaceId, host, pane })
  return ok(undefined, { paneId: opened.paneId, pane })
}
