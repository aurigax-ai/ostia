import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const compileCache = vi.hoisted(() => ({
  enableCompileCache: vi.fn(),
  flushCompileCache: vi.fn(),
}))
const folders = vi.hoisted(() => ({ mkdirSync: vi.fn(), chmodSync: vi.fn() }))
const electronApp = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('node:module', () => compileCache)
vi.mock('node:fs', () => folders)
vi.mock('electron', () => ({
  get app() {
    return electronApp.current
  },
}))

class FakeApp extends EventEmitter {
  getPath = () => '/data/ostia'
}

describe('compileCacheBoot', () => {
  afterEach(() => {
    compileCache.enableCompileCache.mockReset()
    compileCache.flushCompileCache.mockReset()
    folders.mkdirSync.mockReset()
    folders.chmodSync.mockReset()
    vi.resetModules()
  })

  async function boot(): Promise<FakeApp> {
    const app = new FakeApp()
    electronApp.current = app
    await import('./compileCacheBoot')
    return app
  }

  it('keeps compiled main code in a private folder inside the user data folder', async () => {
    await boot()
    const folder = join('/data/ostia', 'compile-cache')
    expect(folders.mkdirSync).toHaveBeenCalledWith(folder, { recursive: true, mode: 0o700 })
    expect(folders.chmodSync).toHaveBeenCalledWith(folder, 0o700)
    expect(compileCache.enableCompileCache).toHaveBeenCalledExactlyOnceWith(folder)
  })

  it('starts without a cache when the folder cannot be made', async () => {
    folders.mkdirSync.mockImplementation(() => {
      throw new Error('EACCES')
    })
    await expect(boot()).resolves.toBeDefined()
    expect(compileCache.enableCompileCache).not.toHaveBeenCalled()
  })

  it('writes the cache once the first window is ready to show, not when the process exits', async () => {
    const app = await boot()
    const window = new EventEmitter()
    app.emit('browser-window-created', {}, window)
    expect(compileCache.flushCompileCache).not.toHaveBeenCalled()
    window.emit('ready-to-show')
    expect(compileCache.flushCompileCache).toHaveBeenCalledOnce()
  })
})
