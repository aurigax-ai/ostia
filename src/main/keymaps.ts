import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { ipcMain } from 'electron'
import { type KeymapContribution, keymapOffered, keymapRef } from '../shared/keymap'
import {
  KEYMAP_FILE_MAX_BYTES,
  type KeymapLoad,
  type KeymapSkip,
  parseKeymapBindings,
} from '../shared/keymapFile'
import { readConfined } from './confinedRead'

export interface KeymapSource {
  extId: string
  dir: string
  keymap: KeymapContribution
}

export interface KeymapDeps {
  keymaps: () => KeymapSource[]
  platform: string
  onError: (ref: string, error: string) => void
  onSkipped: (ref: string, skipped: KeymapSkip[]) => void
}

export function loadKeymap(source: KeymapSource, mac: boolean): KeymapLoad {
  const { extId, dir, keymap } = source
  let root: string
  try {
    root = realpathSync(dir)
  } catch {
    return { ok: false, error: 'extension folder is missing' }
  }
  const file = readConfined(root, resolve(root, keymap.path), KEYMAP_FILE_MAX_BYTES)
  if (!file.ok) return { ok: false, error: `${keymap.path}: ${file.error}` }
  let raw: unknown
  try {
    raw = JSON.parse(file.data.toString('utf8'))
  } catch {
    return { ok: false, error: `${keymap.path}: not valid JSON` }
  }
  const parsed = parseKeymapBindings(raw, mac)
  if (!parsed.ok) return { ok: false, error: `${keymap.path}: ${parsed.error}` }
  return {
    ok: true,
    keymap: {
      extId,
      id: keymap.id,
      label: keymap.label,
      bindings: parsed.bindings,
      skipped: parsed.skipped,
    },
  }
}

export function keymapFor(ref: unknown, deps: KeymapDeps): KeymapLoad {
  if (typeof ref !== 'string') return { ok: false, error: 'no keymap named' }
  const source = deps
    .keymaps()
    .find((s) => keymapRef(s.extId, s.keymap.id) === ref && keymapOffered(s.keymap, deps.platform))
  if (!source) return { ok: false, error: 'no enabled extension offers it on this computer' }
  const res = loadKeymap(source, deps.platform === 'darwin')
  if (!res.ok) deps.onError(ref, res.error)
  else if (res.keymap.skipped.length > 0) deps.onSkipped(ref, res.keymap.skipped)
  return res
}

export function describeSkipped(skipped: readonly KeymapSkip[]): string {
  return skipped.map((s) => `${s.command} ${JSON.stringify(s.value)} (${s.problem})`).join(', ')
}

export function registerKeymapIpc(deps: KeymapDeps): void {
  ipcMain.handle('keymaps:load', (_e, ref: unknown) => keymapFor(ref, deps))
}
