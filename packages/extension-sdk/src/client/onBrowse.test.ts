import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { BrowseProvider } from './browse'
import { serviceMethods } from './extensionMethods'
import { createHostHandlers } from './hostHandlers'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'onbrowse-'))
  writeFileSync(
    join(dir, 'ostia.json'),
    JSON.stringify({
      contributes: {
        fileKinds: [
          { id: 'zips.zip', browse: {} },
          { id: 'zips.view', view: { entry: 'a.html' } },
        ],
      },
    }),
  )
  vi.stubEnv('OSTIA_EXTENSION_ID', 'zips')
  vi.stubEnv('OSTIA_EXTENSION_DIR', dir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const provider: BrowseProvider = {
  list: async () => ({ ok: true, complete: true }),
  read: async () => ({ ok: true }),
}

describe('onBrowse', () => {
  it('registers the kind under the extension id and tells Ostia the process is up', () => {
    const sendRequest = vi.fn().mockResolvedValue({ ok: true })
    const handlers = createHostHandlers()
    serviceMethods({ sendRequest } as unknown as MessageConnection, handlers).onBrowse(
      'zip',
      provider,
    )
    expect(handlers.browse.get('zips.zip')).toBe(provider)
    expect(sendRequest).toHaveBeenCalledWith('ext.registerCommands', { commands: [] })
  })

  it('throws for a name that is not a browse kind in the manifest, and registers nothing', () => {
    const sendRequest = vi.fn()
    const handlers = createHostHandlers()
    const methods = serviceMethods({ sendRequest } as unknown as MessageConnection, handlers)
    expect(() => methods.onBrowse('view', provider)).toThrow(/not a browse kind/)
    expect(() => methods.onBrowse('missing', provider)).toThrow(/not a browse kind/)
    expect(handlers.browse.size).toBe(0)
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
