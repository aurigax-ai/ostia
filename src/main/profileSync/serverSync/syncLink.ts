import { createHash } from 'node:crypto'
import type { ServerJoinRequest, ServerLinkCode } from '../../../shared/profileSync/serverSync'
import { type DeviceKeys, publicBytes } from '../../server/deviceKeys'
import type { DeviceRow } from '../../server/serverRoutes'
import { deviceSlot } from './syncKeyring'

const LINK_DOMAIN = 'ostia-sync/link-code/v1\n'
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const CODE_CHARS = 25
const GROUP = 5
const DIGEST_BYTES = 16

export interface PublicKeys {
  signPub: string
  boxPub: string
}

export function linkCode(joining: PublicKeys, approverSignPub: string): string {
  const digest = createHash('sha256')
    .update(LINK_DOMAIN)
    .update(Buffer.from(joining.signPub, 'base64url'))
    .update(Buffer.from(joining.boxPub, 'base64url'))
    .update(Buffer.from(approverSignPub, 'base64url'))
    .digest()
  let bits = ''
  for (const byte of digest.subarray(0, DIGEST_BYTES)) bits += byte.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; out.length < CODE_CHARS; i += 5) {
    out += BASE32[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  }
  return out.match(new RegExp(`.{${GROUP}}`, 'g'))?.join('-') ?? out
}

export function localPublicKeys(keys: DeviceKeys): PublicKeys {
  return {
    signPub: publicBytes(keys.signPrivate).toString('base64url'),
    boxPub: publicBytes(keys.boxPrivate).toString('base64url'),
  }
}

export function serverAgreesWith(rows: readonly DeviceRow[], local: PublicKeys): boolean {
  const current = rows.filter((r) => r.current)
  const me = current[0]
  return current.length === 1 && me?.signPub === local.signPub && me?.boxPub === local.boxPub
}

export function linkCodesFor(
  rows: readonly DeviceRow[],
  slots: ReadonlySet<string>,
  me: PublicKeys,
): ServerLinkCode[] {
  const others = rows.filter((r) => !r.current)
  const keyed = others.filter((r) => slots.has(deviceSlot(r.id)))
  return (keyed.length > 0 ? keyed : others).map((r) => ({
    deviceName: r.name,
    code: linkCode(me, r.signPub),
  }))
}

export function joinRequestsFor(
  rows: readonly DeviceRow[],
  slots: ReadonlySet<string>,
  me: PublicKeys,
): ServerJoinRequest[] {
  return rows
    .filter((r) => !r.current && !slots.has(deviceSlot(r.id)))
    .map((r) => ({
      deviceId: r.id,
      name: r.name,
      code: linkCode(r, me.signPub),
      createdAt: r.createdAt,
    }))
}

export function approverForCode(
  rows: readonly DeviceRow[],
  me: PublicKeys,
  code: string,
): DeviceRow | undefined {
  return rows.find((r) => !r.current && linkCode(me, r.signPub) === code)
}
