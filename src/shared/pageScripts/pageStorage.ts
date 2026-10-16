/// <reference lib="dom" />
import type { BrowseOutcome, StorageArea } from '../browser/browseRuntime'
import { fail } from './pageText'

export function createStorage(win: Window & typeof globalThis) {
  const dumpArea = (storage: Storage): Record<string, string> => {
    const out: Record<string, string> = {}
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (key !== null) out[key] = storage.getItem(key) ?? ''
    }
    return out
  }

  const areaOf = (area: StorageArea): Storage =>
    area === 'local' ? win.localStorage : win.sessionStorage

  const storageOp = (run: () => void): BrowseOutcome => {
    try {
      run()
      return { ok: true }
    } catch (e) {
      return fail('storage-failed', e instanceof Error ? e.message : String(e))
    }
  }

  return { dumpArea, areaOf, storageOp }
}
