import type { MessageConnection } from 'vscode-jsonrpc/node'
import { parseArgs } from '../common/args'
import { failUsage } from '../common/failure'

export async function runSecretVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  if (sub === 'list') {
    const list =
      await conn.sendRequest<{ name: string; source: string; kind: string }[]>('secret.list')
    for (const s of list) console.log(`${s.source}\t${s.kind}\t${s.name}`)
  } else if (sub === 'get') {
    const { positional, values } = parseArgs(process.argv.slice(4), {
      values: { reason: '--reason' },
    })
    const target = positional[0]
    const reason = values.reason ?? ''
    if (!target) {
      console.error('ostia secret get: missing <name>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{ ok: boolean; value?: string; error?: string }>(
      'secret.get',
      { name: target, reason },
    )
    if (res.ok && res.value !== undefined) {
      process.stdout.write(res.value)
    } else {
      console.error(`ostia: ${res.error ?? 'failed'}`)
      process.exitCode = 1
    }
  } else {
    failUsage('secret')
  }
}

export async function runSandboxVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const value = process.argv[4]
  if (sub === 'request-domain') {
    if (!value) {
      console.error('ostia sandbox request-domain: missing <host>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{
      ok: boolean
      domain?: string
      error?: string
      reason?: string
    }>('sandbox.request-domain', { host: value })
    if (res.ok) {
      console.log(`allowed: ${res.domain}`)
    } else {
      console.error(`ostia: ${res.error}${res.reason ? ` (${res.reason})` : ''}`)
      process.exitCode = 1
    }
  } else if (sub === 'expose') {
    if (!value) {
      console.error('ostia sandbox expose: missing <port>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<{
      ok: boolean
      port?: number
      notice?: string
      error?: string
    }>('sandbox.expose', { port: value })
    if (res.ok && res.notice) {
      console.log(
        `port ${res.port} is reachable on this computer already; forwarding is not needed on macOS`,
      )
    } else if (res.ok) {
      console.log(`exposed: 127.0.0.1:${res.port}`)
    } else {
      console.error(`ostia: ${res.error}`)
      process.exitCode = 1
    }
  } else {
    failUsage('sandbox')
  }
}
