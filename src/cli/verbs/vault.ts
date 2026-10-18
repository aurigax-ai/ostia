import type { MessageConnection } from 'vscode-jsonrpc/node'
import { parseArgs } from '../common/args'
import { type ErrResult, describeErrResult, failUsage } from '../common/failure'
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
      console.error('ostia vault set: missing <KEY>')
      process.exitCode = 1
      return
    }
    const value = await readSecretFromStdin(`Enter value for ${key}`)
    const res = await conn.sendRequest<VaultOk | ErrResult>('vault.set', { key, value, scope })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`ostia: vault set failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'get') {
    const key = rest[0]
    if (!key) {
      console.error('ostia vault get: missing <KEY>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<VaultGetResult | ErrResult>('vault.get', { key, scope })
    if ('value' in res) {
      console.log(res.value)
    } else {
      console.error(`ostia: vault get failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'list') {
    const res = await conn.sendRequest<VaultListResult | ErrResult>('vault.list', { scope })
    if ('keys' in res) {
      for (const k of res.keys) console.log(k)
    } else {
      console.error(`ostia: vault list failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'rm') {
    const key = rest[0]
    if (!key) {
      console.error('ostia vault rm: missing <KEY>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<VaultOk | ErrResult>('vault.delete', { key, scope })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`ostia: vault rm failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else {
    failUsage('vault')
  }
}
