import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { envName } from '../contract/appEnv'
import { EXTENSION_API_ENV, EXTENSION_API_VERSION } from '../contract/extensionApi'
import { connect } from './index'

describe('connect', () => {
  const saved = { ...process.env }
  const dirs: string[] = []
  afterEach(() => {
    process.env = { ...saved }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function extension(api: unknown, appApi: string): void {
    const dir = mkdtempSync(join(tmpdir(), 'api-version-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'ostia.json'), JSON.stringify({ id: 'demo', api }))
    process.env.OSTIA_SOCKET = '/nonexistent/control.sock'
    process.env.OSTIA_TOKEN = 'token'
    process.env[envName('EXTENSION_DIR')] = dir
    process.env[envName(EXTENSION_API_ENV)] = appApi
  }

  it('refuses to start against an app older than the API the extension declares', async () => {
    const [major, minor] = EXTENSION_API_VERSION.split('.').map(Number)
    extension(EXTENSION_API_VERSION, `${major}.${minor - 1}`)
    await expect(connect()).rejects.toThrow(
      `this extension needs extension API ${EXTENSION_API_VERSION}; this ostia provides ${major}.${minor - 1}`,
    )
  })

  it('starts against an app older than the SDK when the extension declares less', async () => {
    const [major, minor] = EXTENSION_API_VERSION.split('.').map(Number)
    extension(`${major}.0`, `${major}.${minor - 1}`)
    await expect(connect()).rejects.toThrow(/ENOENT|connect/)
  })

  it('refuses an extension that declares no API', async () => {
    extension(undefined, EXTENSION_API_VERSION)
    await expect(connect()).rejects.toThrow('declares no api')
  })
})
