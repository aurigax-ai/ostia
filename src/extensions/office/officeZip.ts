import { unzipSync } from 'fflate'
import { GuardStop } from './officeLimits'

export type Parts = Map<string, { data: Uint8Array }>

const COMPOUND_FILE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ZIP_START = [0x50, 0x4b, 0x03, 0x04]
const ENCRYPTED_PACKAGE = new TextEncoder().encode('EncryptedPackage')
const ODF_ENCRYPTED = /<(?:[\w.-]+:)?encryption-data[\s/>]/

function holdsUtf16(bytes: Uint8Array, ascii: Uint8Array): boolean {
  outer: for (let at = 0; at + ascii.length * 2 <= bytes.length; at++) {
    for (let i = 0; i < ascii.length; i++) {
      if (bytes[at + i * 2] !== ascii[i] || bytes[at + i * 2 + 1] !== 0) continue outer
    }
    return true
  }
  return false
}

export function isCompoundFile(bytes: Uint8Array): boolean {
  return COMPOUND_FILE.every((byte, i) => bytes[i] === byte)
}

export function requirePackage(bytes: Uint8Array): void {
  if (isCompoundFile(bytes)) {
    if (holdsUtf16(bytes, ENCRYPTED_PACKAGE)) throw new GuardStop('encrypted')
    return
  }
  if (!ZIP_START.every((byte, i) => bytes[i] === byte)) throw new GuardStop('failed')
}

export function unzipParts(bytes: Uint8Array, wanted: (key: string) => boolean): Parts {
  const parts: Parts = new Map()
  const files = unzipSync(bytes, {
    filter: (file) => !file.name.endsWith('/') && wanted(keyOf(file.name)),
  })
  for (const [name, data] of Object.entries(files)) parts.set(keyOf(name), { data })
  return parts
}

const ODF_PARTS = new Set(['mimetype', 'meta-inf/manifest.xml', 'content.xml'])

export function isOdfPart(key: string): boolean {
  return ODF_PARTS.has(key)
}

export function odfMimetype(parts: Parts): string {
  const manifest = parts.get('meta-inf/manifest.xml')
  if (manifest && ODF_ENCRYPTED.test(new TextDecoder().decode(manifest.data))) {
    throw new GuardStop('encrypted')
  }
  return new TextDecoder().decode(parts.get('mimetype')?.data)
}

function keyOf(name: string): string {
  return name.toLowerCase().replace(/\\/g, '/')
}
