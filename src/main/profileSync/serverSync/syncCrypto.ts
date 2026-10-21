import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { publicBytes, x25519Exchange, x25519FromSeed } from '../../server/deviceKeys'
import { type Argon2Cost, argon2idKey } from '../argon2'

export const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16
const WRAP_VERSION = 1
const SECRET_HEADER_BYTES = 1 + 4 + 1 + 1 + SALT_BYTES
const DEVICE_HEADER_BYTES = 1 + 32
const LABEL_BLOB = 'ostia-sync/blob'
const LABEL_MANIFEST = 'ostia-sync/manifest'
const LABEL_PATH = 'ostia-sync/path'
const LABEL_DEVICE_WRAP = 'ostia-sync/wrap/device'
const AAD_BLOB = 'ostia-sync/blob/v1\n'
const AAD_MANIFEST = 'ostia-sync/manifest/v1'
const AAD_SECRET_WRAP = 'ostia-sync/wrap/passphrase/v1'
const ARGON_MEMORY_MAX_KIB = 256 * 1024
const ARGON_PASSES_MAX = 10
const ARGON_LANES_MAX = 16

export const PRODUCTION_ARGON: Argon2Cost = { memoryKiB: 64 * 1024, passes: 3, lanes: 4 }

interface ManifestFile {
  blobId: string
  hash: string
}

export interface ManifestDevice {
  id: string
  name: string
}

export interface Manifest {
  counter: number
  files: Record<string, ManifestFile>
  devices: ManifestDevice[]
}

export function newProfileKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

function subkey(profileKey: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', profileKey, Buffer.alloc(0), label, KEY_BYTES))
}

function seal(key: Buffer, plain: Buffer, aad: Buffer, nonce: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([nonce, data, cipher.getAuthTag()])
}

function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer | null {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE_BYTES))
    decipher.setAAD(aad)
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
    const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    return null
  }
}

export function contentHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('base64url')
}

export function blobId(profileKey: Buffer, path: string, content: Buffer): string {
  return createHmac('sha256', subkey(profileKey, LABEL_PATH))
    .update(path)
    .update(Buffer.from([0]))
    .update(createHash('sha256').update(content).digest())
    .digest('base64url')
}

function blobNonce(blobKey: Buffer, path: string, content: Buffer): Buffer {
  return createHmac('sha256', blobKey)
    .update(path)
    .update(Buffer.from([0]))
    .update(createHash('sha256').update(content).digest())
    .digest()
    .subarray(0, NONCE_BYTES)
}

export function sealBlob(
  profileKey: Buffer,
  path: string,
  content: Buffer,
  nonce?: Buffer,
): Buffer {
  const blobKey = subkey(profileKey, LABEL_BLOB)
  return seal(
    blobKey,
    content,
    Buffer.from(AAD_BLOB + path),
    nonce ?? blobNonce(blobKey, path, content),
  )
}

export function openBlob(profileKey: Buffer, path: string, sealed: Buffer): Buffer | null {
  return open(subkey(profileKey, LABEL_BLOB), sealed, Buffer.from(AAD_BLOB + path))
}

export function manifestJson(manifest: Manifest): string {
  const files = Object.fromEntries(
    Object.entries(manifest.files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, f]) => [path, { blobId: f.blobId, hash: f.hash }]),
  )
  return JSON.stringify({
    counter: manifest.counter,
    files,
    devices: manifest.devices.map((d) => ({ id: d.id, name: d.name })),
  })
}

export function sealManifest(
  profileKey: Buffer,
  manifest: Manifest,
  nonce: Buffer = randomBytes(NONCE_BYTES),
): Buffer {
  return seal(
    subkey(profileKey, LABEL_MANIFEST),
    Buffer.from(manifestJson(manifest), 'utf8'),
    Buffer.from(AAD_MANIFEST),
    nonce,
  )
}

function parseManifest(text: string): Manifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || !Number.isSafeInteger(raw.counter) || !isRecord(raw.files)) return null
  const files: Record<string, ManifestFile> = {}
  for (const [path, entry] of Object.entries(raw.files)) {
    if (!isRecord(entry) || typeof entry.blobId !== 'string' || typeof entry.hash !== 'string') {
      return null
    }
    files[path] = { blobId: entry.blobId, hash: entry.hash }
  }
  const devices = Array.isArray(raw.devices) ? raw.devices : []
  return {
    counter: raw.counter as number,
    files,
    devices: devices.flatMap((d) =>
      isRecord(d) && typeof d.id === 'string' && typeof d.name === 'string'
        ? [{ id: d.id, name: d.name }]
        : [],
    ),
  }
}

export function openManifest(profileKey: Buffer, sealed: Buffer): Manifest | null {
  const plain = open(subkey(profileKey, LABEL_MANIFEST), sealed, Buffer.from(AAD_MANIFEST))
  return plain ? parseManifest(plain.toString('utf8')) : null
}

export async function wrapWithSecret(
  profileKey: Buffer,
  secret: string,
  params: Argon2Cost = PRODUCTION_ARGON,
  salt: Buffer = randomBytes(SALT_BYTES),
  nonce: Buffer = randomBytes(NONCE_BYTES),
): Promise<Buffer> {
  const header = Buffer.alloc(SECRET_HEADER_BYTES)
  header[0] = WRAP_VERSION
  header.writeUInt32BE(params.memoryKiB, 1)
  header[5] = params.passes
  header[6] = params.lanes
  salt.copy(header, 7)
  const key = await argon2idKey(secret, salt, params)
  const aad = Buffer.concat([Buffer.from(AAD_SECRET_WRAP), header])
  return Buffer.concat([header, seal(key, profileKey, aad, nonce)])
}

export async function unwrapWithSecret(wrap: Buffer, secret: string): Promise<Buffer | null> {
  if (wrap.length < SECRET_HEADER_BYTES || wrap[0] !== WRAP_VERSION) return null
  const params: Argon2Cost = {
    memoryKiB: wrap.readUInt32BE(1),
    passes: wrap[5] ?? 0,
    lanes: wrap[6] ?? 0,
  }
  const sane =
    params.memoryKiB >= 8 * params.lanes &&
    params.memoryKiB <= ARGON_MEMORY_MAX_KIB &&
    params.passes >= 1 &&
    params.passes <= ARGON_PASSES_MAX &&
    params.lanes >= 1 &&
    params.lanes <= ARGON_LANES_MAX
  if (!sane) return null
  const header = wrap.subarray(0, SECRET_HEADER_BYTES)
  const key = await argon2idKey(secret, header.subarray(7), params)
  const aad = Buffer.concat([Buffer.from(AAD_SECRET_WRAP), header])
  return open(key, wrap.subarray(SECRET_HEADER_BYTES), aad)
}

function deviceWrapKey(shared: Buffer, ephemeralPub: Buffer, devicePub: Buffer): Buffer {
  const info = Buffer.concat([Buffer.from(LABEL_DEVICE_WRAP), ephemeralPub, devicePub])
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, KEY_BYTES))
}

export function wrapForDevice(
  profileKey: Buffer,
  deviceBoxPub: Buffer,
  ephemeral: KeyObject = x25519FromSeed(randomBytes(KEY_BYTES)),
  nonce: Buffer = randomBytes(NONCE_BYTES),
): Buffer {
  const ephemeralPub = publicBytes(ephemeral)
  const header = Buffer.concat([Buffer.from([WRAP_VERSION]), ephemeralPub])
  const key = deviceWrapKey(x25519Exchange(ephemeral, deviceBoxPub), ephemeralPub, deviceBoxPub)
  return Buffer.concat([header, seal(key, profileKey, header, nonce)])
}

export function unwrapForDevice(wrap: Buffer, boxPrivate: KeyObject): Buffer | null {
  if (wrap.length < DEVICE_HEADER_BYTES || wrap[0] !== WRAP_VERSION) return null
  const header = wrap.subarray(0, DEVICE_HEADER_BYTES)
  const ephemeralPub = header.subarray(1)
  try {
    const shared = x25519Exchange(boxPrivate, ephemeralPub)
    const key = deviceWrapKey(shared, ephemeralPub, publicBytes(boxPrivate))
    const profileKey = open(key, wrap.subarray(DEVICE_HEADER_BYTES), header)
    return profileKey?.length === KEY_BYTES ? profileKey : null
  } catch {
    return null
  }
}
