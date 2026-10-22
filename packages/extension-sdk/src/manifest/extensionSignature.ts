import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto'
import { constants, readFileSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
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

function signedFiles(dir: string): string[] | null {
  const plan = planCopy(dir)
  return plan.ok ? plan.files.filter((file) => file !== EXTENSION_SIGNATURE_FILE) : null
}

function digestOf(entries: { file: string; hash: string }[]): string {
  const lines = entries.map(({ file, hash }) => `${file.split(sep).join('/')}\0${hash}\n`)
  return sha256(lines.sort().join(''))
}

export function extensionDigest(dir: string): string | null {
  const files = signedFiles(dir)
  if (files === null) return null
  return digestOf(files.map((file) => ({ file, hash: sha256(readFileSync(join(dir, file))) })))
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${path} is not a plain file`)
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted()
      hash.update(chunk)
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

export async function extensionDigestAsync(
  dir: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const files = signedFiles(dir)
  if (files === null) return null
  const entries: { file: string; hash: string }[] = []
  for (const file of files) {
    signal?.throwIfAborted()
    entries.push({ file, hash: await hashFile(join(dir, file), signal) })
  }
  return digestOf(entries)
}

export function extensionStamp(dir: string): string | null {
  const files = signedFiles(dir)
  if (files === null) return null
  try {
    return [...files, EXTENSION_SIGNATURE_FILE]
      .sort()
      .map((file) => {
        try {
          const stat = statSync(join(dir, file))
          return `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        } catch {
          return `${file}:missing`
        }
      })
      .join('\n')
  } catch {
    return null
  }
}

function message(id: string, version: string, digest: string): Buffer {
  return Buffer.from(`${MESSAGE_PREFIX}\n${id}\n${version}\n${digest}`)
}

function publicKeyOf(encoded: string): KeyObject | null {
  try {
    const key = createPublicKey({
      key: Buffer.from(encoded, 'base64'),
      format: 'der',
      type: 'spki',
    })
    return key.asymmetricKeyType === 'ed25519' ? key : null
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

function judge(
  signed: ExtensionSignature | null,
  digest: string | null,
  id: string,
  version: string,
  key: KeyObject | null,
): SignatureCheck {
  if (!key) return { ok: false, problem: 'this build holds no official key' }
  if (!signed) return { ok: false, problem: `${EXTENSION_SIGNATURE_FILE} is missing or unreadable` }
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

export function checkExtensionSignature(
  dir: string,
  id: string,
  version: string,
  publicKey: string | undefined,
): SignatureCheck {
  const key = publicKey ? publicKeyOf(publicKey) : null
  return judge(readSignature(dir), key ? extensionDigest(dir) : null, id, version, key)
}

export async function checkExtensionSignatureAsync(
  dir: string,
  id: string,
  version: string,
  publicKey: string | undefined,
  signal?: AbortSignal,
): Promise<SignatureCheck> {
  const key = publicKey ? publicKeyOf(publicKey) : null
  const digest = key ? await extensionDigestAsync(dir, signal) : null
  return judge(readSignature(dir), digest, id, version, key)
}
