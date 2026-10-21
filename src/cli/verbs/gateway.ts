import type { MessageConnection } from 'vscode-jsonrpc/node'
import {
  describeErrResult,
  type ErrResult,
  failUsage,
  failVerb,
  failWith,
  isErrResult,
} from '../common/failure'
import { tsvLine } from '../common/lineField'

interface GatewayOk {
  ok: true
}
interface GatewayStatusResult {
  running: boolean
  host: string | null
  port: number | null
  fingerprint: string | null
  deviceCount: number
}
interface GatewayPairResult {
  v: number
  host: string | null
  port: number | null
  fingerprint: string | null
  pairCode: string
  name: string
}
interface GatewayDevice {
  deviceId: string
  name: string
  pubkey: string
  caps: string[]
  createdAt: string
}
interface GatewayDevicesResult {
  devices: GatewayDevice[]
}

export async function runGatewayVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]

  if (sub === 'pair') {
    const res = await conn.sendRequest<GatewayPairResult | ErrResult>('gateway.pair', {})
    if (isErrResult(res)) {
      failWith(describeErrResult(res))
      return
    }
    console.log(JSON.stringify(res))
    console.log(`\nostia-pair://${Buffer.from(JSON.stringify(res)).toString('base64url')}`)
    console.log('\n(scan the JSON above as a QR from the phone, or paste the ostia-pair:// URI)')
  } else if (sub === 'status') {
    const res = await conn.sendRequest<GatewayStatusResult | ErrResult>('gateway.status', {})
    if (isErrResult(res)) {
      failWith(describeErrResult(res))
      return
    }
    console.log(JSON.stringify(res))
  } else if (sub === 'devices') {
    const res = await conn.sendRequest<GatewayDevicesResult>('gateway.devices', {})
    if (res.devices.length === 0) {
      console.error('(no paired devices)')
      return
    }
    for (const d of res.devices) {
      console.log(tsvLine([d.deviceId, d.name, d.caps.join(','), d.createdAt]))
    }
  } else if (sub === 'revoke') {
    const deviceId = process.argv[4]
    if (!deviceId) {
      failVerb('missing arguments')
      return
    }
    const res = await conn.sendRequest<GatewayOk | ErrResult>('gateway.revoke', { deviceId })
    if (res.ok) {
      console.log('ok')
    } else {
      failWith(describeErrResult(res))
    }
  } else {
    failUsage('gateway')
  }
}
