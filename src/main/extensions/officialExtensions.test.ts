import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionManifest } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { OFFICIAL_UPDATE_PENDING } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import { signExtension } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionSignature'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AcceptedVersions,
  OFFICIAL_EXTENSION_PUBLIC_KEY,
  OfficialRevocations,
  OfficialVerifier,
  UPDATABLE_BUILTINS,
} from './officialExtensions'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'official-'))
  dirs.push(dir)
  return dir
}

const manifest = (version: string): ExtensionManifest =>
  ({
    id: 'csv',
    version,
    capabilities: [],
    contributes: {
      commands: [],
      secrets: [],
      assist: [],
      settings: [],
      paneChips: [],
      workspaceChips: [],
      sidebarItems: false,
    },
  }) as unknown as ExtensionManifest

describe('the official key and the updatable built-ins', () => {
  it('holds an Ed25519 public key or nothing yet', () => {
    if (OFFICIAL_EXTENSION_PUBLIC_KEY === '') return
    const { publicKey } = generateKeyPairSync('ed25519')
    const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    expect(Buffer.from(OFFICIAL_EXTENSION_PUBLIC_KEY, 'base64')).toHaveLength(
      Buffer.from(der, 'base64').length,
    )
  })

  it('leaves the built-ins tied to the app out', () => {
    for (const id of ['agent', 'skills', 'activity', 'graphs', 'handoff', 'assistant']) {
      expect(UPDATABLE_BUILTINS).not.toContain(id)
    }
  })
})

describe('AcceptedVersions', () => {
  it('keeps the highest version per id in a file only the user can read', () => {
    const path = join(tmp(), 'versions.json')
    const accepted = new AcceptedVersions(path)
    expect(accepted.highest('csv')).toBeUndefined()
    accepted.record('csv', '1.2.0')
    accepted.record('csv', '1.1.0')
    expect(accepted.highest('csv')).toBe('1.2.0')
    accepted.record('csv', '1.3.0')
    expect(new AcceptedVersions(path).highest('csv')).toBe('1.3.0')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('OfficialVerifier', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')

  function setup(recordAccepted = true) {
    const root = tmp()
    const folder = join(root, 'csv')
    mkdirSync(folder)
    writeFileSync(join(folder, 'ostia.json'), '{}')
    writeFileSync(join(folder, 'main.js'), 'one')
    signExtension(
      folder,
      'csv',
      '1.1.0',
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    )
    const onVerified = vi.fn()
    const verifier = new OfficialVerifier({
      publicKey: () => publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      revocations: new OfficialRevocations(join(root, 'revoked.json')),
      accepted: new AcceptedVersions(join(root, 'seen.json')),
      onVerified,
      recordAccepted,
    })
    return { folder, onVerified, verifier, accepted: new AcceptedVersions(join(root, 'seen.json')) }
  }

  it('answers at once, verifies off the call and then answers from its cache until the files change', async () => {
    const { folder, onVerified, verifier } = setup()
    expect(verifier.check(folder, manifest('1.1.0'), manifest('1.0.0'))).toBe(
      OFFICIAL_UPDATE_PENDING,
    )
    expect(onVerified).not.toHaveBeenCalled()
    await verifier.settled()
    expect(onVerified).toHaveBeenCalledTimes(1)
    expect(verifier.check(folder, manifest('1.1.0'), manifest('1.0.0'))).toBeNull()
    expect(verifier.check(folder, manifest('1.1.0'), manifest('1.0.0'))).toBeNull()
    expect(onVerified).toHaveBeenCalledTimes(1)

    writeFileSync(join(folder, 'main.js'), 'two, and longer')
    expect(verifier.check(folder, manifest('1.1.0'), manifest('1.0.0'))).toBe(
      OFFICIAL_UPDATE_PENDING,
    )
    await verifier.settled()
    expect(verifier.check(folder, manifest('1.1.0'), manifest('1.0.0'))).toBe(
      'the files differ from what was signed',
    )
  })

  it('records an accepted version only when it is the one that runs, never from browsing', async () => {
    const browsing = setup(false)
    browsing.verifier.check(browsing.folder, manifest('1.1.0'), manifest('1.0.0'))
    await browsing.verifier.settled()
    expect(browsing.accepted.highest('csv')).toBeUndefined()

    const running = setup(true)
    running.verifier.check(running.folder, manifest('1.1.0'), manifest('1.0.0'))
    await running.verifier.settled()
    expect(running.accepted.highest('csv')).toBe('1.1.0')
  })

  it('refuses an id that stays tied to the app before it reads a file', () => {
    const { folder, verifier } = setup()
    expect(verifier.check(folder, { ...manifest('1.1.0'), id: 'agent' }, manifest('1.0.0'))).toBe(
      'agent stays tied to the app',
    )
  })
})
