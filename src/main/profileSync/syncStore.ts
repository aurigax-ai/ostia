import { readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { SecretSyncStatus, SyncOffer } from '../../shared/profileSync/profileSync'
import { type JsonObject, readProfileFolders, readTopFile, SETTINGS_FILE } from './profile'

const STATE_FILE = 'sync-state.json'
export const BASE_DIR = 'sync-base'
const BASE_FILE = 'base.json'

export interface SyncState {
  target: string
  version: string | null
  lastSync: string | null
  offers: SyncOffer[]
  installedAtSync: string[]
  skipped: string[]
  heldBack: string[]
  secrets: SecretSyncStatus | null
}

export interface LocalProfile {
  settings: JsonObject | null
  settingsInvalid: boolean
  settingsTime: number
  files: Map<string, string>
  times: Map<string, number>
  skipped: string[]
}

export const stamp = (path: string, time: number): void => {
  try {
    const at = new Date(time)
    utimesSync(path, at, at)
  } catch {}
}

interface SyncStoreDeps {
  userData: string
  configDir: string
}

export function createSyncStore(deps: SyncStoreDeps) {
  function path(...parts: string[]): string {
    return join(deps.userData, ...parts)
  }

  function loadState(target: string): SyncState {
    const fresh: SyncState = {
      target,
      version: null,
      lastSync: null,
      offers: [],
      installedAtSync: [],
      skipped: [],
      heldBack: [],
      secrets: null,
    }
    try {
      const raw = JSON.parse(readFileSync(path(STATE_FILE), 'utf8')) as SyncState
      if (!isRecord(raw) || raw.target !== target) return fresh
      return {
        target,
        version: typeof raw.version === 'string' ? raw.version : null,
        lastSync: typeof raw.lastSync === 'string' ? raw.lastSync : null,
        offers: Array.isArray(raw.offers) ? raw.offers : [],
        installedAtSync: Array.isArray(raw.installedAtSync) ? raw.installedAtSync : [],
        skipped: Array.isArray(raw.skipped) ? raw.skipped : [],
        heldBack: Array.isArray(raw.heldBack) ? raw.heldBack : [],
        secrets: isRecord(raw.secrets) ? raw.secrets : null,
      }
    } catch {
      return fresh
    }
  }

  function saveState(state: SyncState): void {
    writeFileAtomic(path(STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
  }

  function loadBase(target: string): Map<string, string> | null {
    try {
      const raw = JSON.parse(readFileSync(path(BASE_DIR, BASE_FILE), 'utf8')) as unknown
      if (!isRecord(raw) || raw.target !== target || !isRecord(raw.files)) return null
      const files = new Map<string, string>()
      for (const [path, text] of Object.entries(raw.files)) {
        if (typeof text === 'string') files.set(path, text)
      }
      return files
    } catch {
      return null
    }
  }

  function saveBase(target: string, files: ReadonlyMap<string, string>): void {
    const body = { target, files: Object.fromEntries(files) }
    writeFileAtomic(path(BASE_DIR, BASE_FILE), `${JSON.stringify(body)}\n`)
  }

  function readLocal(): LocalProfile {
    const top = readTopFile(path(SETTINGS_FILE))
    let settings: JsonObject | null = null
    let settingsInvalid = top === 'skipped'
    let settingsTime = 0
    if (top && top !== 'skipped') {
      settingsTime = top.mtimeMs
      try {
        const parsed = JSON.parse(top.text) as unknown
        if (isRecord(parsed)) settings = parsed
        else settingsInvalid = true
      } catch {
        settingsInvalid = true
      }
    }
    const folders = readProfileFolders(deps.configDir)
    return {
      settings,
      settingsInvalid,
      settingsTime,
      files: folders.files,
      times: folders.times,
      skipped: folders.skipped,
    }
  }

  return { path, loadState, saveState, loadBase, saveBase, readLocal }
}

export type SyncStore = ReturnType<typeof createSyncStore>
