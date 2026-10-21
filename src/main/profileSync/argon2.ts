import { argon2idAsync } from '@noble/hashes/argon2.js'

const KEY_BYTES = 32
const TICK_MS = 10

export interface Argon2Cost {
  memoryKiB: number
  passes: number
  lanes: number
}

export async function argon2idKey(
  secret: string,
  salt: Uint8Array,
  cost: Argon2Cost,
): Promise<Buffer> {
  const key = await argon2idAsync(Buffer.from(secret, 'utf8'), salt, {
    t: cost.passes,
    m: cost.memoryKiB,
    p: cost.lanes,
    dkLen: KEY_BYTES,
    asyncTick: TICK_MS,
  })
  return Buffer.from(key)
}
