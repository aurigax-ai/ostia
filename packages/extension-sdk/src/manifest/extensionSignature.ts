import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { isRecord } from '../contract/isRecord'
import { planCopy } from './marketplaceManifest'

export const EXTENSION_SIGNATURE_FILE = 'ostia.sig'

const MESSAGE_PREFIX = 'ostia-extension/v1'

export interface ExtensionSignature {
  digest: string
  signature: string
}

export type SignatureCheck = { ok: true } | { ok: false; problem: string }

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function extensionDigest(dir: string): string | null {
  const plan = planCopy(dir)
  if (!plan.ok) return null
  const lines = plan.files
    .filter((file) => file !== EXTENSION_SIGNATURE_FILE)
    .map((file) => `${file.split(sep).join('/')}\0${sha256(readFileSync(join(dir, file)))}\n`)
    .sort()
  return sha256(lines.join(''))
}

function message(id: string, version: string, digest: string): Buffer {
  return Buffer.from(`${MESSAGE_PREFIX}\n${id}\n${version}\n${digest}`)
}

function publicKeyOf(encoded: string): KeyObject | null {
  try {
    return createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' })
  } catch {
    return null
  }
}

export function signExtension(
  dir: string,
  id: string,
  version: string,
  privateKeyPem: string,
): ExtensionSignature {
  const digest = extensionDigest(dir)
  if (digest === null) throw new Error(`${dir} holds a link or special file, or is too large`)
  const signature = sign(null, message(id, version, digest), createPrivateKey(privateKeyPem))
  const result = { digest, signature: signature.toString('base64') }
  writeFileSync(join(dir, EXTENSION_SIGNATURE_FILE), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

function readSignature(dir: string): ExtensionSignature | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, EXTENSION_SIGNATURE_FILE), 'utf8'))
    if (!isRecord(raw)) return null
    const { digest, signature } = raw
    return typeof digest === 'string' && typeof signature === 'string'
      ? { digest, signature }
      : null
  } catch {
    return null
  }
}

export function checkExtensionSignature(
  dir: string,
  id: string,
  version: string,
  publicKey: string | undefined,
): SignatureCheck {
  const key = publicKey ? publicKeyOf(publicKey) : null
  if (!key) return { ok: false, problem: 'this build holds no official key' }
  const signed = readSignature(dir)
  if (!signed) return { ok: false, problem: `${EXTENSION_SIGNATURE_FILE} is missing or unreadable` }
  const digest = extensionDigest(dir)
  if (digest !== signed.digest)
    return { ok: false, problem: 'the files differ from what was signed' }
  const genuine = verify(
    null,
    message(id, version, digest),
    key,
    Buffer.from(signed.signature, 'base64'),
  )
  return genuine ? { ok: true } : { ok: false, problem: 'the signature does not match' }
}
