import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkExtensionSignature,
  EXTENSION_SIGNATURE_FILE,
  extensionDigest,
  signExtension,
} from './extensionSignature'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function extension(): string {
  const dir = mkdtempSync(join(tmpdir(), 'signed-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'locales'))
  writeFileSync(join(dir, 'ostia.json'), '{"id":"csv","version":"1.1.0"}')
  writeFileSync(join(dir, 'main.js'), 'console.log(1)')
  writeFileSync(join(dir, 'locales', 'fr.json'), '{}')
  return dir
}

function keys(): { privatePem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

describe('extension signatures', () => {
  it('accepts a folder signed by the official key', () => {
    const dir = extension()
    const { privatePem, publicKey } = keys()
    signExtension(dir, 'csv', '1.1.0', privatePem)
    expect(checkExtensionSignature(dir, 'csv', '1.1.0', publicKey)).toEqual({ ok: true })
  })

  it('refuses a file changed, added or removed after signing', () => {
    const { privatePem, publicKey } = keys()
    for (const tamper of [
      (dir: string) => writeFileSync(join(dir, 'main.js'), 'steal()'),
      (dir: string) => writeFileSync(join(dir, 'extra.js'), 'x'),
      (dir: string) => rmSync(join(dir, 'locales'), { recursive: true }),
    ]) {
      const dir = extension()
      signExtension(dir, 'csv', '1.1.0', privatePem)
      tamper(dir)
      expect(checkExtensionSignature(dir, 'csv', '1.1.0', publicKey)).toEqual({
        ok: false,
        problem: 'the files differ from what was signed',
      })
    }
  })

  it('refuses another key, another id or version, and a missing signature', () => {
    const dir = extension()
    const { privatePem, publicKey } = keys()
    expect(checkExtensionSignature(dir, 'csv', '1.1.0', publicKey)).toMatchObject({ ok: false })
    signExtension(dir, 'csv', '1.1.0', privatePem)
    expect(checkExtensionSignature(dir, 'csv', '1.1.0', keys().publicKey)).toEqual({
      ok: false,
      problem: 'the signature does not match',
    })
    expect(checkExtensionSignature(dir, 'pdf', '1.1.0', publicKey)).toMatchObject({ ok: false })
    expect(checkExtensionSignature(dir, 'csv', '1.0.0', publicKey)).toMatchObject({ ok: false })
    expect(checkExtensionSignature(dir, 'csv', '1.1.0', undefined)).toEqual({
      ok: false,
      problem: 'this build holds no official key',
    })
  })

  it('leaves the signature file out of the digest', () => {
    const dir = extension()
    const before = extensionDigest(dir)
    signExtension(dir, 'csv', '1.1.0', keys().privatePem)
    expect(extensionDigest(dir)).toBe(before)
    expect(extensionDigest(dir)).not.toBeNull()
    writeFileSync(join(dir, EXTENSION_SIGNATURE_FILE), 'garbage')
    expect(extensionDigest(dir)).toBe(before)
  })
})
