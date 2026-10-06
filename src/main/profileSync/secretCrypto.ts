import { argon2, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { canonicalJson } from './merge'
import { isObject } from './profile'

export const BUNDLE_FORMAT = 1
export const KDF_MEMORY_KIB = 64 * 1024
export const KDF_PASSES = 3
export const KDF_PARALLELISM = 1
const KDF_MEMORY_RANGE = [19 * 1024, 1024 * 1024] as const
const KDF_PASSES_RANGE = [1, 10] as const
const KDF_PARALLELISM_RANGE = [1, 8] as const
const KEY_BYTES = 32
const SALT_BYTES = 16
const NONCE_BYTES = 12
const TAG_BYTES = 16
const RECOVERY_BYTES = 20
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export interface Kdf {
  name: 'argon2id'
  memory: number
  passes: number
  parallelism: number
}

export interface Wrap {
  salt: string
  nonce: string
  data: string
  tag: string
}

export interface BundleHeader {
  format: typeof BUNDLE_FORMAT
  keyId: string
  wrapId: string
  kdf: Kdf
  password: Wrap
  recovery: Wrap
}

interface SealedBundle {
  header: BundleHeader
  nonce: string
  data: string
  tag: string
}

export const DEFAULT_KDF: Kdf = {
  name: 'argon2id',
  memory: KDF_MEMORY_KIB,
  passes: KDF_PASSES,
  parallelism: KDF_PARALLELISM,
}

const b64 = (bytes: Buffer): string => bytes.toString('base64')

const bytesOf = (text: unknown, length?: number): Buffer | null => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
  const bytes = Buffer.from(text, 'base64')
  return length === undefined || bytes.length === length ? bytes : null
}

const inRange = (value: unknown, [min, max]: readonly [number, number]): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

function deriveKey(secret: string, salt: Buffer, kdf: Kdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(secret, 'utf8'),
        nonce: salt,
        parallelism: kdf.parallelism,
        tagLength: KEY_BYTES,
        memory: kdf.memory,
        passes: kdf.passes,
      },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })
}

function seal(
  key: Buffer,
  plain: Buffer,
  aad: Buffer,
): { nonce: Buffer; data: Buffer; tag: Buffer } {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  return { nonce, data, tag: cipher.getAuthTag() }
}

function unseal(key: Buffer, nonce: Buffer, data: Buffer, tag: Buffer, aad: Buffer): Buffer | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()])
  } catch {
    return null
  }
}

const WRAP_AAD = Buffer.from('ostia-secret-sync-key-v1')

export async function wrapKey(dataKey: Buffer, secret: string, kdf: Kdf): Promise<Wrap> {
  const salt = randomBytes(SALT_BYTES)
  const sealed = seal(await deriveKey(secret, salt, kdf), dataKey, WRAP_AAD)
  return { salt: b64(salt), nonce: b64(sealed.nonce), data: b64(sealed.data), tag: b64(sealed.tag) }
}

export async function unwrapKey(wrap: Wrap, secret: string, kdf: Kdf): Promise<Buffer | null> {
  const salt = bytesOf(wrap.salt, SALT_BYTES)
  const nonce = bytesOf(wrap.nonce, NONCE_BYTES)
  const data = bytesOf(wrap.data, KEY_BYTES)
  const tag = bytesOf(wrap.tag, TAG_BYTES)
  if (!salt || !nonce || !data || !tag) return null
  return unseal(await deriveKey(secret, salt, kdf), nonce, data, tag, WRAP_AAD)
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function newRecoveryKey(): string {
  const bytes = randomBytes(RECOVERY_BYTES)
  let bits = ''
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 5) out += BASE32[Number.parseInt(bits.slice(i, i + 5), 2)]
  return out.match(/.{4}/g)?.join('-') ?? out
}

export function normalizeRecoveryKey(input: string): string {
  const compact = input.toUpperCase().replace(/[\s-]/g, '')
  return compact.match(/.{1,4}/g)?.join('-') ?? compact
}

export async function newHeader(
  dataKey: Buffer,
  password: string,
  recoveryKey: string,
): Promise<BundleHeader> {
  return {
    format: BUNDLE_FORMAT,
    keyId: randomUUID(),
    wrapId: randomUUID(),
    kdf: DEFAULT_KDF,
    password: await wrapKey(dataKey, password, DEFAULT_KDF),
    recovery: await wrapKey(dataKey, normalizeRecoveryKey(recoveryKey), DEFAULT_KDF),
  }
}

export async function withPassword(
  header: BundleHeader,
  dataKey: Buffer,
  password: string,
): Promise<BundleHeader> {
  return {
    ...header,
    wrapId: randomUUID(),
    password: await wrapKey(dataKey, password, header.kdf),
  }
}

const isWrap = (v: unknown): v is Wrap =>
  isObject(v) && ['salt', 'nonce', 'data', 'tag'].every((k) => typeof v[k] === 'string')

export function parseHeader(raw: unknown): BundleHeader | null {
  if (!isObject(raw) || raw.format !== BUNDLE_FORMAT) return null
  if (typeof raw.keyId !== 'string' || typeof raw.wrapId !== 'string') return null
  const kdf = raw.kdf
  if (!isObject(kdf) || kdf.name !== 'argon2id') return null
  if (!inRange(kdf.memory, KDF_MEMORY_RANGE) || !inRange(kdf.passes, KDF_PASSES_RANGE)) return null
  if (!inRange(kdf.parallelism, KDF_PARALLELISM_RANGE)) return null
  if (!isWrap(raw.password) || !isWrap(raw.recovery)) return null
  return {
    format: BUNDLE_FORMAT,
    keyId: raw.keyId,
    wrapId: raw.wrapId,
    kdf: { name: 'argon2id', memory: kdf.memory, passes: kdf.passes, parallelism: kdf.parallelism },
    password: raw.password,
    recovery: raw.recovery,
  }
}

const headerAad = (header: BundleHeader): Buffer => Buffer.from(canonicalJson(header))

export function sealBundle(header: BundleHeader, dataKey: Buffer, plain: string): string {
  const sealed = seal(dataKey, Buffer.from(plain, 'utf8'), headerAad(header))
  const bundle: SealedBundle = {
    header,
    nonce: b64(sealed.nonce),
    data: b64(sealed.data),
    tag: b64(sealed.tag),
  }
  return `${JSON.stringify(bundle)}\n`
}

export interface OpenedBundle {
  header: BundleHeader
  open: (dataKey: Buffer) => string | null
  openWithPassword: (password: string) => Promise<string | null>
}

export function openBundle(text: string): OpenedBundle | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  const header = parseHeader(raw.header)
  const nonce = bytesOf(raw.nonce, NONCE_BYTES)
  const data = bytesOf(raw.data)
  const tag = bytesOf(raw.tag, TAG_BYTES)
  if (!header || !nonce || !data || !tag) return null
  const open = (dataKey: Buffer): string | null =>
    unseal(dataKey, nonce, data, tag, headerAad(header))?.toString('utf8') ?? null
  return {
    header,
    open,
    openWithPassword: async (password) => {
      const key = await unwrapKey(header.password, password, header.kdf)
      return key ? open(key) : null
    },
  }
}
