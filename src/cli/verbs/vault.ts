import type { MessageConnection } from 'vscode-jsonrpc/node'
import { parseArgs } from '../common/args'
import { describeErrResult, type ErrResult, failUsage, failVerb, failWith } from '../common/failure'
import { readSecretFromStdin } from '../common/stdinText'

interface VaultOk {
  ok: true
}
interface VaultGetResult {
  value: string
}
interface VaultListResult {
  keys: string[]
}

export async function runVaultVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const { positional: rest, booleans } = parseArgs(process.argv.slice(4), {
    booleans: { global: '--global' },
  })
  const scope: 'project' | 'global' = booleans.global ? 'global' : 'project'

  if (sub === 'set') {
    const key = rest[0]
    if (!key) {
      failVerb('missing arguments')
      return
    }
    const value = await readSecretFromStdin(`Enter value for ${key}`)
    const res = await conn.sendRequest<VaultOk | ErrResult>('vault.set', { key, value, scope })
    if (res.ok) {
      console.log('ok')
    } else {
      failWith(describeErrResult(res))
    }
  } else if (sub === 'get') {
    const key = rest[0]
    if (!key) {
      failVerb('missing arguments')
      return
    }
    const res = await conn.sendRequest<VaultGetResult | ErrResult>('vault.get', { key, scope })
    if ('value' in res) {
      console.log(res.value)
    } else {
      failWith(describeErrResult(res))
    }
  } else if (sub === 'list') {
    const res = await conn.sendRequest<VaultListResult | ErrResult>('vault.list', { scope })
    if ('keys' in res) {
      for (const k of res.keys) console.log(k)
    } else {
      failWith(describeErrResult(res))
    }
  } else if (sub === 'rm') {
    const key = rest[0]
    if (!key) {
      failVerb('missing arguments')
      return
    }
    const res = await conn.sendRequest<VaultOk | ErrResult>('vault.delete', { key, scope })
    if (res.ok) {
      console.log('ok')
    } else {
      failWith(describeErrResult(res))
    }
  } else {
    failUsage('vault')
  }
}
