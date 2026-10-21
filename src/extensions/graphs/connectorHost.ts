import type { OstiaExtension } from '@aurigax-ai/ostia-extension-sdk'
import {
  type Clock,
  connectorNode,
  httpConnector,
  type McpReply,
  type NativeConnector,
  NodeError,
  type NodeKind,
  type ResolvedConnection,
} from '@aurigax-ai/wire'

export type ConnectorExt = Pick<OstiaExtension, 'mcpCall' | 'connection'>

export const NATIVE_CONNECTORS: readonly NativeConnector[] = [httpConnector()]
export const SANDBOXED_CONNECTOR = 'connectors do not run in a sandboxed workspace'

async function mcpReply(
  ext: ConnectorExt,
  server: string,
  tool: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<McpReply> {
  const reply = await ext.mcpCall(server, tool, input, signal)
  if (!reply.ok) return { ok: false, error: reply.message ?? reply.error }
  return {
    ok: true,
    text: reply.text,
    ...(reply.structured !== undefined ? { structured: reply.structured } : {}),
  }
}

async function resolved(ext: ConnectorExt, name: string): Promise<ResolvedConnection | null> {
  const reply = await ext.connection(name)
  if (!reply.ok || !reply.connection) return null
  const { kind, fields, secrets } = reply.connection
  return { name, kind, fields, secrets }
}

export function ostiaConnectorNode(
  ext: ConnectorExt,
  clock: Clock,
  sandboxed: (workspaceId: string) => boolean,
): NodeKind {
  const inner = connectorNode({
    clock,
    mcpCall: (server, tool, input, signal) => mcpReply(ext, server, tool, input, signal),
    native: NATIVE_CONNECTORS,
    connection: (name) => resolved(ext, name),
  })
  return {
    ...inner,
    start: async (input, ctx) => {
      if (sandboxed(ctx.scope)) throw new NodeError('ConnectorFailed', SANDBOXED_CONNECTOR)
      return inner.start(input, ctx)
    },
  }
}
