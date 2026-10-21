import type { SnippetEntry } from '@aurigax-ai/ostia-extension-sdk/contract/snippets'
import type { WorkspaceEntry } from '../../panes/paneList'
import type { RpcOutcome } from '../controlDispatch'

const SNIPPETS_MAX = 200

export interface PhoneSnippetDeps {
  listWorkspaces: () => Promise<WorkspaceEntry[]>
  ownSnippets: (workspaceId: string | undefined) => SnippetEntry[]
  redact: (text: string) => Promise<string>
}

async function redactedOptional(text: string | undefined, redact: PhoneSnippetDeps['redact']) {
  return text === undefined ? undefined : await redact(text)
}

async function wireSnippet(snippet: SnippetEntry, redact: PhoneSnippetDeps['redact']) {
  const description = await redactedOptional(snippet.description, redact)
  const args = []
  for (const arg of snippet.arguments) {
    const argDescription = await redactedOptional(arg.description, redact)
    const defaultValue = await redactedOptional(arg.defaultValue, redact)
    args.push({
      name: arg.name,
      ...(argDescription ? { description: argDescription } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    })
  }
  return {
    name: await redact(snippet.name),
    ...(description ? { description } : {}),
    command: await redact(snippet.command),
    arguments: args,
    source: snippet.source,
  }
}

export async function snippetList(
  p: Record<string, unknown>,
  deps: PhoneSnippetDeps,
): Promise<RpcOutcome> {
  let workspaceId: string | undefined
  if (p.sessionId !== undefined) {
    const workspace =
      typeof p.sessionId === 'string'
        ? (await deps.listWorkspaces()).find((w) => w.workspaceId === p.sessionId)
        : undefined
    if (
      !workspace ||
      workspace.kind === 'scratch' ||
      workspace.kind === 'manager' ||
      workspace.sandboxed
    ) {
      return { ok: false, code: -32602, message: 'unknown-session' }
    }
    workspaceId = workspace.workspaceId
  }
  const listed = deps.ownSnippets(workspaceId)
  const own = [
    ...listed.filter((s) => s.source === 'user'),
    ...listed.filter((s) => s.source === 'workspace'),
  ].slice(0, SNIPPETS_MAX)
  try {
    const snippets = []
    for (const snippet of own) snippets.push(await wireSnippet(snippet, deps.redact))
    return { ok: true, result: { snippets } }
  } catch {
    return { ok: false, code: -32603, message: 'redaction-failed' }
  }
}
