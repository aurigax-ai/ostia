import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  hkdfSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from 'node:crypto'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { publicBytes, x25519Exchange, x25519FromSeed } from '../../server/deviceKeys'
import { type Argon2Cost, argon2idKey } from '../argon2'

export const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16
const WRAP_VERSION = 1
const DEVICE_WRAP_VERSION = 2
const EPHEMERAL_BYTES = 32
const COUNTER_BYTES = 8
const SIGNATURE_BYTES = 64
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')
const SECRET_HEADER_BYTES = 1 + 4 + 1 + 1 + SALT_BYTES
const LABEL_BLOB = 'ostia-sync/blob'
const LABEL_MANIFEST = 'ostia-sync/manifest'
const LABEL_PATH = 'ostia-sync/path'
const LABEL_DEVICE_WRAP = 'ostia-sync/wrap/device'
const WRAP_SIGNATURE_CONTEXT = 'ostia-sync/wrap/sig/v1\n'
const AAD_BLOB = 'ostia-sync/blob/v1\n'
const AAD_MANIFEST = 'ostia-sync/manifest/v1'
const AAD_SECRET_WRAP = 'ostia-sync/wrap/passphrase/v1'

export const PRODUCTION_ARGON: Argon2Cost = { memoryKiB: 64 * 1024, passes: 3, lanes: 4 }

interface ManifestFile {
  blobId: string
  hash: string
}

export interface ManifestDevice {
  id: string
  name: string
  signPub: string
  boxPub: string
  createdAt: number
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

function manifestJson(manifest: Manifest): string {
  const files = Object.fromEntries(
    Object.entries(manifest.files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, f]) => [path, { blobId: f.blobId, hash: f.hash }]),
  )
  return JSON.stringify({
    counter: manifest.counter,
    files,
    devices: manifest.devices.map((d) => ({
      id: d.id,
      name: d.name,
      signPub: d.signPub,
      boxPub: d.boxPub,
      createdAt: d.createdAt,
    })),
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

function isManifestDevice(d: unknown): d is ManifestDevice {
  return (
    isRecord(d) &&
    typeof d.id === 'string' &&
    typeof d.name === 'string' &&
    typeof d.signPub === 'string' &&
    typeof d.boxPub === 'string' &&
    typeof d.createdAt === 'number' &&
    Number.isFinite(d.createdAt)
  )
}

function manifestDeviceOf(d: ManifestDevice): ManifestDevice {
  return { id: d.id, name: d.name, signPub: d.signPub, boxPub: d.boxPub, createdAt: d.createdAt }
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
    devices: devices.flatMap((d) => (isManifestDevice(d) ? [manifestDeviceOf(d)] : [])),
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
    params.memoryKiB <= PRODUCTION_ARGON.memoryKiB &&
    params.passes >= 1 &&
    params.passes <= PRODUCTION_ARGON.passes &&
    params.lanes >= 1 &&
    params.lanes <= PRODUCTION_ARGON.lanes
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

export interface WrapSigner {
  id: string
  signPrivate: KeyObject
}

export interface DeviceWrap {
  signerId: string
  counter: number
  signed: Buffer
  signature: Buffer
  ephemeralPub: Buffer
  nonce: Buffer
  ciphertext: Buffer
}

function signatureMessage(slot: string, signed: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${WRAP_SIGNATURE_CONTEXT}${slot}\n`), signed])
}

export function wrapForDevice(
  profileKey: Buffer,
  deviceBoxPub: Buffer,
  slot: string,
  signer: WrapSigner,
  counter: number,
  ephemeral: KeyObject = x25519FromSeed(randomBytes(KEY_BYTES)),
  nonce: Buffer = randomBytes(NONCE_BYTES),
): Buffer {
  const ephemeralPub = publicBytes(ephemeral)
  const id = Buffer.from(signer.id, 'utf8')
  const counterBytes = Buffer.alloc(COUNTER_BYTES)
  counterBytes.writeBigUInt64BE(BigInt(counter))
  const header = Buffer.concat([
    Buffer.from([DEVICE_WRAP_VERSION, id.length]),
    id,
    counterBytes,
    ephemeralPub,
    nonce,
  ])
  const key = deviceWrapKey(x25519Exchange(ephemeral, deviceBoxPub), ephemeralPub, deviceBoxPub)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.concat([header, Buffer.from(slot)]))
  const ciphertext = Buffer.concat([cipher.update(profileKey), cipher.final(), cipher.getAuthTag()])
  const signed = Buffer.concat([header, ciphertext])
  const signature = sign(null, signatureMessage(slot, signed), signer.signPrivate)
  return Buffer.concat([signed, signature])
}

export function parseDeviceWrap(wrap: Buffer): DeviceWrap | null {
  if (wrap.length < 2 || wrap[0] !== DEVICE_WRAP_VERSION) return null
  const idLength = wrap[1] ?? 0
  const ciphertextLength = KEY_BYTES + TAG_BYTES
  const signedLength =
    2 + idLength + COUNTER_BYTES + EPHEMERAL_BYTES + NONCE_BYTES + ciphertextLength
  if (idLength === 0 || wrap.length !== signedLength + SIGNATURE_BYTES) return null
  const counter = Number(wrap.readBigUInt64BE(2 + idLength))
  if (!Number.isSafeInteger(counter)) return null
  const ephemeralAt = 2 + idLength + COUNTER_BYTES
  return {
    signerId: wrap.subarray(2, 2 + idLength).toString('utf8'),
    counter,
    signed: wrap.subarray(0, signedLength),
    signature: wrap.subarray(signedLength),
    ephemeralPub: wrap.subarray(ephemeralAt, ephemeralAt + EPHEMERAL_BYTES),
    nonce: wrap.subarray(
      ephemeralAt + EPHEMERAL_BYTES,
      ephemeralAt + EPHEMERAL_BYTES + NONCE_BYTES,
    ),
    ciphertext: wrap.subarray(signedLength - ciphertextLength, signedLength),
  }
}

export function wrapSignedBy(wrap: DeviceWrap, slot: string, signPub: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(signPub, 'base64url')]),
      format: 'der',
      type: 'spki',
    })
    return verify(null, signatureMessage(slot, wrap.signed), key, wrap.signature)
  } catch {
    return false
  }
}

export function openDeviceWrap(
  wrap: DeviceWrap,
  slot: string,
  boxPrivate: KeyObject,
): Buffer | null {
  try {
    const shared = x25519Exchange(boxPrivate, wrap.ephemeralPub)
    const key = deviceWrapKey(shared, wrap.ephemeralPub, publicBytes(boxPrivate))
    const header = wrap.signed.subarray(0, wrap.signed.length - wrap.ciphertext.length)
    const decipher = createDecipheriv('aes-256-gcm', key, wrap.nonce)
    decipher.setAAD(Buffer.concat([header, Buffer.from(slot)]))
    decipher.setAuthTag(wrap.ciphertext.subarray(KEY_BYTES))
    const profileKey = Buffer.concat([
      decipher.update(wrap.ciphertext.subarray(0, KEY_BYTES)),
      decipher.final(),
    ])
    return profileKey.length === KEY_BYTES ? profileKey : null
  } catch {
    return null
  }
}
