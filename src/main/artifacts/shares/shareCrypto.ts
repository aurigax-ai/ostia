import { createCipheriv, createDecipheriv, hkdfSync, pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const FORMAT_VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const PBKDF2_ROUNDS = 600_000
const AAD_PREFIX = 'ostia-share/1:'
const COMBINE_INFO = 'ostia-share/1/key'

const SHARE_SALT_BYTES = 16
export const SHARE_OVERHEAD = 1 + NONCE_BYTES + TAG_BYTES

type EncryptedMode = 'link' | 'password'

export interface KeyMaterial {
  mode: EncryptedMode
  password?: string
  salt?: Buffer
  fragment?: Buffer
}

const stretch = promisify(pbkdf2)

export function newFragmentKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function newSalt(): Buffer {
  return randomBytes(SHARE_SALT_BYTES)
}

export async function deriveShareKey({
  mode,
  password,
  salt,
  fragment,
}: KeyMaterial): Promise<Buffer> {
  if (mode === 'link') {
    if (!fragment || fragment.length !== KEY_BYTES) throw new Error('a link share needs a key')
    return fragment
  }
  if (password === undefined || !salt || salt.length !== SHARE_SALT_BYTES) {
    throw new Error('a password share needs a password and a salt')
  }
  const stretched = await stretch(
    Buffer.from(password.normalize('NFKC'), 'utf8'),
    salt,
    PBKDF2_ROUNDS,
    KEY_BYTES,
    'sha256',
  )
  if (!fragment) return stretched
  const combined = hkdfSync(
    'sha256',
    Buffer.concat([stretched, fragment]),
    Buffer.alloc(0),
    COMBINE_INFO,
    KEY_BYTES,
  )
  return Buffer.from(combined)
}

export function encryptShare(
  id: string,
  key: Buffer,
  plaintext: Buffer,
  nonce: Buffer = randomBytes(NONCE_BYTES),
): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(AAD_PREFIX + id, 'utf8'))
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, sealed])
}

export function decryptShare(id: string, key: Buffer, blob: Buffer): Buffer {
  if (blob.length < SHARE_OVERHEAD || blob[0] !== FORMAT_VERSION) {
    throw new Error('unsupported share format')
  }
  const nonce = blob.subarray(1, 1 + NONCE_BYTES)
  const tag = blob.subarray(blob.length - TAG_BYTES)
  const sealed = blob.subarray(1 + NONCE_BYTES, blob.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(AAD_PREFIX + id, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(sealed), decipher.final()])
}

export function shareLink(url: string, fragment: Buffer | null): string {
  return fragment ? `${url}#k=${fragment.toString('base64url')}` : url
}
