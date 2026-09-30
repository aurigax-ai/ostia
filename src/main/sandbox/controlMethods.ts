import { ResponseError } from 'vscode-jsonrpc/node'
import { registerControlMethod } from '../controlServer'
import type { DomainRequests } from './domainRequests'

export interface SandboxMethodsDeps {
  domains: DomainRequests
}

export function registerSandboxMethods(deps: SandboxMethodsDeps): void {
  registerControlMethod('sandbox.request-domain', {
    handler: async (params, ctx) => {
      const { host } = (params ?? {}) as { host?: unknown }
      if (typeof host !== 'string') throw new ResponseError(-32602, 'host must be a string')
      return deps.domains.request(ctx.identity.workspaceId, ctx.identity.paneId, host)
    },
  })
}
