import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { approvals } from '../approvals/approvals'
import { getByPaneId } from '../control/idRegistry'
import { programPath } from '../platform/systemRequirements'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { prepareSecrets } from './secretInjection'
import { SecretService } from './secretService'
import { vaultKeys, vaultValue } from './vault'
import { WorkspaceAgents } from './workspaceAgents'

interface SecretServicesDeps {
  workspaceSandboxes: WorkspaceSandboxes
  paneForWorkspace: (workspaceId: string) => string | undefined
}

export function createSecretServices({ workspaceSandboxes, paneForWorkspace }: SecretServicesDeps) {
  const GH_TOKEN_TTL_MS = 60_000
  let ghTokenCache: { at: number; value: string | null } | null = null

  function ghToken(): string | null {
    if (ghTokenCache && Date.now() - ghTokenCache.at < GH_TOKEN_TTL_MS) return ghTokenCache.value
    let value: string | null = null
    const gh = programPath('gh')
    if (gh) {
      try {
        value =
          execFileSync(gh, ['auth', 'token'], { encoding: 'utf8', timeout: 3000 }).trim() || null
      } catch {
        value = null
      }
    }
    ghTokenCache = { at: Date.now(), value }
    return value
  }

  const secretService: SecretService = new SecretService({
    home: homedir,
    env: () => process.env,
    ghToken,
    vault: {
      list: (workspaceId) => [
        ...vaultKeys('global', workspaceId).map((key) => ({ key, scope: 'global' as const })),
        ...vaultKeys('project', workspaceId).map((key) => ({ key, scope: 'project' as const })),
      ],
      get: (key, scope, workspaceId) => vaultValue(key, scope, workspaceId),
    },
    grantedIds: (workspaceId) =>
      (workspaceSandboxes.settings(workspaceId).secrets ?? []).map((g) => g.id),
    ask: async ({ workspaceId, paneId, name, reason }) => {
      const identity = getByPaneId(paneId) ?? getByPaneId(paneForWorkspace(workspaceId) ?? '')
      const queue = approvals()
      if (!identity || !queue) return 'deny'
      return queue.request({
        externalId: identity.externalId,
        windowId: identity.windowId,
        paneId: identity.paneId,
        workspaceId,
        caps: [],
        kind: 'secret',
        subject: name,
        action: `ostia secret get ${name}`,
        detail: reason,
      })
    },
  })

  const workspaceAgents = new WorkspaceAgents()

  async function injectSecrets(
    workspaceId: string,
  ): Promise<{ env: Record<string, string>; notice: string }> {
    const grants = workspaceSandboxes.settings(workspaceId).secrets ?? []
    if (grants.length === 0) return { env: {}, notice: '' }
    const dir = join(workspaceSandboxes.tmp.tmpDir(workspaceId), 'secrets')
    const prepared = prepareSecrets({
      grants,
      list: secretService.list(workspaceId),
      value: (id) => secretService.value(workspaceId, id),
      dir,
    })
    const env = { ...prepared.env }
    try {
      const socket = await workspaceAgents.ensure(
        workspaceId,
        workspaceSandboxes.tmp.sshAgentSocket(workspaceId),
        prepared.sshKeys,
      )
      if (socket) env.SSH_AUTH_SOCK = socket
    } catch {
      prepared.missing.push('ssh-agent')
    }
    const notice =
      prepared.missing.length > 0
        ? `\x1b[33m Granted secrets not found: ${prepared.missing.join(', ')}\x1b[0m\r\n`
        : ''
    return { env, notice }
  }

  return { secretService, workspaceAgents, injectSecrets }
}
