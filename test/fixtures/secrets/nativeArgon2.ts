import { argon2Sync } from 'node:crypto'
import type { Argon2Cost } from '../../../src/main/profileSync/argon2'

export async function argon2idKey(
  secret: string,
  salt: Uint8Array,
  cost: Argon2Cost,
): Promise<Buffer> {
  return argon2Sync('argon2id', {
    message: Buffer.from(secret, 'utf8'),
    nonce: salt,
    parallelism: cost.lanes,
    tagLength: 32,
    memory: cost.memoryKiB,
    passes: cost.passes,
  })
}
