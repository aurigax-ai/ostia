import { ResponseError } from 'vscode-jsonrpc/node'
import { registerControlMethod } from '../control/controlServer'
import type { DomainRequests } from './domainRequests'
import type { PortRequests } from './portRequests'

export interface SandboxMethodsDeps {
  domains: DomainRequests
  ports?: PortRequests
}

export function registerSandboxMethods(deps: SandboxMethodsDeps): void {
  registerControlMethod('sandbox.request-domain', {
    handler: async (params, ctx) => {
      const { host } = (params ?? {}) as { host?: unknown }
      if (typeof host !== 'string') throw new ResponseError(-32602, 'host must be a string')
      return deps.domains.request(ctx.identity.workspaceId, ctx.identity.paneId, host)
    },
  })
  registerControlMethod('sandbox.expose', {
    handler: async (params, ctx) => {
      const { port } = (params ?? {}) as { port?: unknown }
      if (!deps.ports) return { ok: false, error: 'unsupported' }
      return deps.ports.request(ctx.identity.workspaceId, ctx.identity.paneId, String(port ?? ''))
    },
  })
}
