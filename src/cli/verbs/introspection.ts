import type { MessageConnection } from 'vscode-jsonrpc/node'

interface WhoAmI {
  externalId: string
  paneId?: string
  workspaceId?: string
}

export async function runWhoami(conn: MessageConnection): Promise<void> {
  const who = await conn.sendRequest<WhoAmI>('whoami')
  const state = who.paneId
    ? await conn.sendRequest<{ cwd?: string; running?: boolean } | null>('pane.info')
    : null
  console.log(
    JSON.stringify(
      { ...who, ...(state ? { cwd: state.cwd ?? null, running: state.running === true } : {}) },
      null,
      2,
    ),
  )
}

export async function runDocs(conn: MessageConnection): Promise<void> {
  const topic = process.argv[3]
  const res = await conn.sendRequest<{ cli: string }>('docs', topic ? { topic } : {})
  console.log(res.cli)
}
