import { registerControlMethod } from '../control/controlServer'
import type { McpHost } from './mcpHost'

export interface ExtensionMcpDeps {
  mcp: () => McpHost | null
}

const NO_HOST = { ok: false, error: 'This MCP server is not connected.' }

export function registerExtensionMcp(deps: ExtensionMcpDeps): void {
  registerControlMethod('ext.mcpCall', {
    callers: 'extensions',
    cap: 'mcp',
    handler: async (params, ctx) => {
      const host = deps.mcp()
      if (!host) return NO_HOST
      const { server, tool, input } = (params ?? {}) as Record<string, unknown>
      const abort = new AbortController()
      const cancelled = ctx.token?.onCancellationRequested(() => abort.abort())
      try {
        return await host.callForExtension(server, tool, input, abort.signal)
      } finally {
        cancelled?.dispose()
      }
    },
  })
  registerControlMethod('ext.mcpServers', {
    callers: 'extensions',
    cap: 'mcp',
    handler: async () => ({ ok: true, servers: (await deps.mcp()?.serversForExtensions()) ?? [] }),
  })
}
