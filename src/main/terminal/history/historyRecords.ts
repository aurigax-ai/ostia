import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { deflateRaw, inflateRaw } from 'node:zlib'

const deflate = promisify(deflateRaw)
const inflate = promisify(inflateRaw)
const CIPHER = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

export function newHistoryKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export async function sealLines(key: Buffer, lines: readonly string[]): Promise<Buffer> {
  const packed = await deflate(Buffer.from(lines.join('\n'), 'utf8'))
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(CIPHER, key, nonce)
  const body = Buffer.concat([cipher.update(packed), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

export async function openLines(key: Buffer, record: Buffer): Promise<string[]> {
  const nonce = record.subarray(0, NONCE_BYTES)
  const tag = record.subarray(record.length - TAG_BYTES)
  const decipher = createDecipheriv(CIPHER, key, nonce)
  decipher.setAuthTag(tag)
  const packed = Buffer.concat([
    decipher.update(record.subarray(NONCE_BYTES, record.length - TAG_BYTES)),
    decipher.final(),
  ])
  return (await inflate(packed)).toString('utf8').split('\n')
}
