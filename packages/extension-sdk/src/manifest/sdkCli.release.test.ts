import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runSdkCli } from './sdkCli'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.OSTIA_EXTENSION_SIGNING_KEY
})

function manifest(version: string): string {
  return JSON.stringify({ id: 'hello', name: 'Hello', version, api: '7.0' })
}

function folder(root: string, path: string, version: string): void {
  mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, path, 'ostia.json'), manifest(version))
}

function marketplace(extra: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-release-'))
  dirs.push(root)
  folder(root, 'extensions/hello', '1.2.0')
  folder(root, 'versions/hello/1.1.0', '1.1.0')
  folder(root, 'versions/hello/1.3.0', '1.3.0')
  writeFileSync(
    join(root, 'ostia-marketplace.json'),
    JSON.stringify({ name: 'M', extensions: ['extensions/hello'], ...extra }),
  )
  return root
}

describe('validate a marketplace that keeps older releases', () => {
  it('accepts history folders older than the listed release', () => {
    const root = marketplace({ history: ['versions/hello/1.1.0'] })
    expect(runSdkCli(['validate', root]).code).toBe(0)
  })

  it('refuses a history folder that is not older, or of another extension', () => {
    const newer = marketplace({ history: ['versions/hello/1.3.0'] })
    expect(runSdkCli(['validate', newer]).lines[0]).toContain('is not older than the listed 1.2.0')
    const stranger = marketplace({ history: ['versions/hello/1.1.0'] })
    folder(stranger, 'versions/other/1.0.0', '1.0.0')
    writeFileSync(
      join(stranger, 'versions/other/1.0.0/ostia.json'),
      JSON.stringify({ id: 'other', name: 'O', version: '1.0.0', api: '7.0' }),
    )
    writeFileSync(
      join(stranger, 'ostia-marketplace.json'),
      JSON.stringify({
        name: 'M',
        extensions: ['extensions/hello'],
        history: ['versions/other/1.0.0'],
      }),
    )
    expect(runSdkCli(['validate', stranger]).lines[0]).toContain(
      "'other' is not an extension of this marketplace",
    )
  })
})

describe('sign and verify', () => {
  it('signs a folder with the key in the environment and verifies it with the public half', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const root = marketplace({})
    const dir = join(root, 'extensions/hello')
    process.env.OSTIA_EXTENSION_SIGNING_KEY = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
    expect(runSdkCli(['sign', dir]).code).toBe(0)
    const encoded = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    expect(runSdkCli(['verify', dir, encoded])).toEqual({
      code: 0,
      lines: ['ok: hello 1.2.0 is signed by the official key'],
    })
    writeFileSync(join(dir, 'main.js'), 'changed')
    expect(runSdkCli(['verify', dir, encoded]).code).toBe(1)
  })

  it('refuses to sign without a key', () => {
    const root = marketplace({})
    expect(runSdkCli(['sign', join(root, 'extensions/hello')]).code).toBe(1)
  })
})
