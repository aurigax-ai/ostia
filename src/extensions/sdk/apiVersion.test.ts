import { afterEach, describe, expect, it } from 'vitest'
import { connect } from '.'
import { envName, legacyEnvName } from '../../shared/appEnv'
import { EXTENSION_API_ENV, EXTENSION_API_VERSION } from '../../shared/extensionApi'

describe('connect', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('refuses to start against an app whose extension API is older than the SDK', async () => {
    const [major, minor] = EXTENSION_API_VERSION.split('.').map(Number)
    process.env.OSTIA_SOCKET = '/nonexistent/control.sock'
    process.env.OSTIA_TOKEN = 'token'
    process.env[envName(EXTENSION_API_ENV)] = `${major - 1}.${minor}`
    await expect(connect()).rejects.toThrow(
      `this extension needs extension API ${EXTENSION_API_VERSION}; this ostia provides ${major - 1}.${minor}`,
    )
  })

  it('still reads the old PINE_ names from an app released before the rename', async () => {
    const [major, minor] = EXTENSION_API_VERSION.split('.').map(Number)
    process.env.PINE_SOCKET = '/nonexistent/control.sock'
    process.env.PINE_TOKEN = 'token'
    process.env[legacyEnvName(EXTENSION_API_ENV)] = `${major - 1}.${minor}`
    await expect(connect()).rejects.toThrow(`this ostia provides ${major - 1}.${minor}`)
  })
})
